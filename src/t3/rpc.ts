import { EventEmitter } from "node:events";

import WebSocket from "ws";

import type { Logger } from "../log.ts";

/**
 * A minimal client for T3 Code's WebSocket RPC, which speaks Effect RPC's JSON
 * protocol: `Request` in, `Chunk` (streams, acknowledged with `Ack`) and `Exit`
 * out, plus `Ping`/`Pong` keepalives.
 */

export class RpcError extends Error {
  readonly tag: string;

  constructor(tag: string, cause: unknown) {
    super(`${tag} failed: ${summarizeCause(cause)}`, { cause });
    this.tag = tag;
  }
}

function summarizeCause(cause: unknown): string {
  const text = JSON.stringify(cause) ?? String(cause);
  const message = /"message":"([^"]{1,300})"/.exec(text)?.[1];
  return message ?? text.slice(0, 300);
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface Subscription {
  readonly tag: string;
  readonly payload: unknown;
  readonly onChunk: (values: unknown[]) => void;
  requestId: string | null;
}

interface RpcEvents {
  open: [];
  close: [Error | null];
}

const PING_MS = 10_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export interface RpcConnectionOptions {
  /** Server origin, e.g. `http://100.64.0.1:3773`. */
  readonly url: string;
  readonly token: string;
  readonly log: Logger;
}

export function webSocketUrl(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "?orchestrationProtocol=2";
  return url.toString();
}

/** One reconnecting socket. Subscriptions are re-sent after every reconnect. */
export class RpcConnection extends EventEmitter<RpcEvents> {
  private socket: WebSocket | null = null;
  private nextId = 1n;
  private readonly calls = new Map<string, PendingCall>();
  private readonly subscriptions = new Set<Subscription>();
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private closed = false;
  private lastFailure: string | null = null;

  private readonly options: RpcConnectionOptions;

  constructor(options: RpcConnectionOptions) {
    super();
    this.options = options;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.closed = false;
    this.open();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  /** Unary request. Rejects if the socket is down. */
  call<T = unknown>(tag: string, payload: unknown, timeoutMs = 15_000): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`T3 Code server is not connected (${tag})`));
    }
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`${tag} timed out`));
      }, timeoutMs);
      this.calls.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  }

  /** Long-lived stream, resubscribed on reconnect. */
  subscribe(tag: string, payload: unknown, onChunk: (values: unknown[]) => void): () => void {
    const subscription: Subscription = { tag, payload, onChunk, requestId: null };
    this.subscriptions.add(subscription);
    if (this.isOpen) this.startSubscription(subscription);
    return () => {
      this.subscriptions.delete(subscription);
      if (subscription.requestId && this.isOpen) {
        this.send({ _tag: "Interrupt", requestId: subscription.requestId });
      }
    };
  }

  private startSubscription(subscription: Subscription) {
    const id = String(this.nextId++);
    subscription.requestId = id;
    this.send({
      _tag: "Request",
      id,
      tag: subscription.tag,
      payload: subscription.payload,
      headers: [],
    });
  }

  private send(message: unknown) {
    this.socket?.send(JSON.stringify(message));
  }

  private open() {
    const { url, token, log } = this.options;
    const socket = new WebSocket(webSocketUrl(url), {
      headers: { authorization: `Bearer ${token}` },
      handshakeTimeout: 10_000,
    });
    this.socket = socket;
    socket.on("unexpected-response", (_request, response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => (body += chunk.toString()));
      response.on("end", () => {
        this.fail(new Error(`HTTP ${response.statusCode}: ${body.slice(0, 300)}`));
      });
    });
    socket.on("open", () => {
      this.attempt = 0;
      this.lastFailure = null;
      log.info(`connected to ${url}`);
      this.pingTimer = setInterval(() => this.send({ _tag: "Ping" }), PING_MS);
      for (const subscription of this.subscriptions) this.startSubscription(subscription);
      this.emit("open");
    });
    socket.on("message", (data) => this.onMessage(data.toString()));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(null));
  }

  private fail(error: Error | null) {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    socket.removeAllListeners();
    socket.on("error", () => {});
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const call of this.calls.values()) call.reject(new Error("T3 Code connection closed"));
    this.calls.clear();
    for (const subscription of this.subscriptions) subscription.requestId = null;
    this.emit("close", error);
    if (this.closed) return;
    const message = error?.message ?? "connection closed";
    if (message !== this.lastFailure) {
      this.lastFailure = message;
      this.options.log.warn(`T3 Code connection to ${this.options.url} lost: ${message}`);
    }
    const delay = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]!;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private onMessage(text: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message._tag) {
      case "Ping":
        this.send({ _tag: "Pong" });
        return;
      case "Chunk": {
        const requestId = String(message.requestId);
        this.send({ _tag: "Ack", requestId });
        const subscription = [...this.subscriptions].find((s) => s.requestId === requestId);
        if (subscription && Array.isArray(message.values)) subscription.onChunk(message.values);
        return;
      }
      case "Exit": {
        const requestId = String(message.requestId);
        const exit = message.exit as { _tag?: string; value?: unknown; cause?: unknown } | undefined;
        const call = this.calls.get(requestId);
        if (call) {
          this.calls.delete(requestId);
          if (exit?._tag === "Success") call.resolve(exit.value);
          else call.reject(new RpcError("request", exit?.cause ?? exit));
          return;
        }
        const subscription = [...this.subscriptions].find((s) => s.requestId === requestId);
        if (subscription) {
          // The server ended a stream we still want; reopen it shortly.
          subscription.requestId = null;
          this.options.log.warn(
            `${subscription.tag} ended: ${summarizeCause(exit?.cause ?? exit)}; resubscribing`,
          );
          setTimeout(() => {
            if (this.subscriptions.has(subscription) && this.isOpen && !subscription.requestId) {
              this.startSubscription(subscription);
            }
          }, 2_000);
        }
        return;
      }
      case "Defect":
        this.options.log.warn("T3 Code server reported a protocol defect", message.defect);
        return;
      case "ClientProtocolError":
        this.options.log.warn("T3 Code rejected a message", message.error);
        return;
    }
  }
}
