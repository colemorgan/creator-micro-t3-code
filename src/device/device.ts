import { EventEmitter } from "node:events";

import type { HIDAsync } from "node-hid";

import { DARK_FRAME, type LightingFrame } from "./lighting.ts";
import {
  CHANNEL_RPC,
  decodeReport,
  encodeRpcRequest,
  type Endpoint,
  findEndpoints,
  FRAMINGS,
  type Framing,
  isDeepEqual,
  LineAssembler,
  MAX_RPC_ID,
  NOTIFY_METHODS,
  parseRpcLine,
  reconcileEndpoint,
  RPC_METHODS,
  type Transport,
} from "./protocol.ts";
import type { Logger } from "../log.ts";

export type DeviceInput =
  /** `act`: 1 press, 0 release, 2 knob detent. */
  | { readonly type: "key"; readonly key: string; readonly act: number | null }
  /** angle 0–1 clockwise from +x (0.75 = up); distance 0–1. */
  | { readonly type: "joystick"; readonly angle: number; readonly distance: number };

export interface DeviceState {
  readonly connected: boolean;
  readonly transport: Transport | null;
  readonly firmwareVersion: string | null;
  readonly batteryPercentage: number | null;
  readonly charging: boolean | null;
}

export const DISCONNECTED: DeviceState = {
  connected: false,
  transport: null,
  firmwareVersion: null,
  batteryPercentage: null,
  charging: null,
};

interface DeviceEvents {
  input: [DeviceInput];
  state: [DeviceState];
}

const POLL_MS = 2_000;
const RETRY_AFTER_FAILURE_MS = 10_000;
const RPC_TIMEOUT_MS = 2_500;
const STATUS_POLL_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

type NodeHid = typeof import("node-hid");
let nodeHid: Promise<NodeHid> | null = null;
// A native addon: load it lazily so a broken prebuild reports clearly.
const loadNodeHid = () => (nodeHid ??= import("node-hid"));

export async function listEndpoints(): Promise<Endpoint[]> {
  const hid = await loadNodeHid();
  return findEndpoints(await hid.devicesAsync());
}

/**
 * Owns one Codex Micro: discovery, reconnects, framing detection, serialized
 * JSON-RPC (the firmware handles one request at a time), deduplicated lighting
 * writes, and key/joystick notifications.
 */
export class CodexMicroDevice extends EventEmitter<DeviceEvents> {
  private hid: HIDAsync | null = null;
  private endpoint: Endpoint | null = null;
  private framing: Framing | null = null;
  private state: DeviceState = DISCONNECTED;
  private readonly lines = new LineAssembler();
  private readonly pending = new Map<string, (result: { ok: boolean; value: unknown }) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private consecutiveFailures = 0;
  private applied: LightingFrame | null = null;
  private wanted: LightingFrame | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private retryAt = 0;
  private lastTopology = "";
  private lastError: string | null = null;
  private stopped = false;
  private polling = false;

  private readonly log: Logger;

  constructor(log: Logger) {
    super();
    this.log = log;
  }

  get current(): DeviceState {
    return this.state;
  }

  start(): void {
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      void this.poll().finally(() => {
        if (!this.stopped) this.pollTimer = setTimeout(tick, POLL_MS);
      });
    };
    tick();
    this.statusTimer = setInterval(() => void this.refreshStatus(), STATUS_POLL_MS);
  }

  /** Leaves the pad dark rather than frozen on stale thread states. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.hid) {
      await Promise.race([this.write(DARK_FRAME), sleep(1_000)]).catch(() => {});
    }
    await this.disconnect();
  }

  /** Shows `frame` now, or as soon as a device connects. */
  setLighting(frame: LightingFrame): Promise<void> {
    this.wanted = frame;
    return this.flushLighting();
  }

  /** Forget what was written so the next frame is sent in full (after a dim). */
  invalidateLighting(): void {
    this.applied = null;
  }

  private flushLighting(): Promise<void> {
    return this.enqueue(async () => {
      const frame = this.wanted;
      if (!this.hid || !frame || isDeepEqual(frame, this.applied)) return;
      await this.write(frame);
    }).catch((error) => {
      this.applied = null;
      this.log.warn("lighting update failed", error);
    });
  }

  private async write(frame: LightingFrame): Promise<void> {
    const keysAndAmbient = this.applied?.zones;
    if (!isDeepEqual(keysAndAmbient, frame.zones)) {
      await this.send(RPC_METHODS.lightingConfig, frame.zones);
    }
    if (!isDeepEqual(this.applied?.slots, frame.slots)) {
      await this.send(RPC_METHODS.slotLighting, frame.slots);
    }
    this.applied = frame;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => sleep(15),
      () => sleep(15),
    );
    return run;
  }

  /** Public, serialized RPC (used by `doctor`). */
  call(method: string, params: unknown): Promise<unknown> {
    return this.enqueue(() => this.send(method, params));
  }

  private async send(method: string, params: unknown, framing = this.framing): Promise<unknown> {
    const device = this.hid;
    if (!device || !framing) throw new Error("Codex Micro is not connected");
    const id = Math.floor(Math.random() * MAX_RPC_ID);
    const response = new Promise<{ ok: boolean; value: unknown }>((resolve) => {
      this.pending.set(String(id), resolve);
    });
    try {
      for (const report of encodeRpcRequest(method, params, id, framing)) {
        await device.write(Buffer.from(report));
      }
      const result = await Promise.race([
        response,
        sleep(RPC_TIMEOUT_MS).then(() => {
          throw new Error(`Codex Micro ${method} timed out`);
        }),
      ]);
      if (!result.ok) throw new Error(`Codex Micro ${method} failed: ${String(result.value)}`);
      this.consecutiveFailures = 0;
      return result.value;
    } catch (error) {
      // A handle can go dead without a read error (sleep/wake, a dropped
      // Bluetooth link). A run of failures reopens it.
      if (++this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && this.framing) {
        void this.disconnect();
      }
      throw error;
    } finally {
      this.pending.delete(String(id));
    }
  }

  private onData = (data: Buffer) => {
    const report = decodeReport(data);
    if (!report || report.channel !== CHANNEL_RPC) return;
    for (const line of this.lines.push(report)) {
      const message = parseRpcLine(line);
      if (!message) continue;
      if (message.kind === "response") {
        this.pending.get(message.id)?.({
          ok: message.error === null,
          value: message.error ?? message.result,
        });
        continue;
      }
      const { method, params } = message;
      if (method === NOTIFY_METHODS.key && typeof params.k === "string") {
        const act = typeof params.act === "number" ? params.act : null;
        this.emit("input", { type: "key", key: params.k, act });
      } else if (
        method === NOTIFY_METHODS.joystick &&
        typeof params.a === "number" &&
        typeof params.d === "number"
      ) {
        this.emit("input", { type: "joystick", angle: params.a, distance: params.d });
      }
    }
  };

  private setState(next: DeviceState) {
    if (isDeepEqual(next, this.state)) return;
    this.state = next;
    this.emit("state", next);
  }

  private async disconnect(): Promise<void> {
    const device = this.hid;
    this.hid = null;
    this.endpoint = null;
    this.framing = null;
    this.applied = null;
    this.consecutiveFailures = 0;
    this.lines.reset();
    for (const resolve of this.pending.values()) resolve({ ok: false, value: "disconnected" });
    this.pending.clear();
    if (device) {
      device.removeAllListeners("data");
      await device.close().catch(() => {});
    }
    this.setState(DISCONNECTED);
  }

  private async refreshStatus(): Promise<void> {
    if (!this.hid) return;
    try {
      const status = (await this.call(RPC_METHODS.status, null)) as Record<string, unknown> | null;
      this.setState({
        connected: true,
        transport: this.endpoint?.transport ?? null,
        firmwareVersion: typeof status?.version === "string" ? status.version : null,
        batteryPercentage: typeof status?.battery === "number" ? status.battery : null,
        charging: typeof status?.is_charging === "boolean" ? status.is_charging : null,
      });
    } catch (error) {
      this.log.debug("status request failed", error);
    }
  }

  private async connect(next: Endpoint): Promise<void> {
    const { HIDAsync } = await loadNodeHid();
    // Non-exclusive so the keyboard and consumer collections keep working:
    // over Bluetooth they share this very handle (macOS).
    const device = await HIDAsync.open(next.path, { nonExclusive: true });
    device.on("data", this.onData);
    device.on("error", (error: unknown) => {
      if (this.hid !== device) return;
      this.log.warn("Codex Micro connection lost", error);
      void this.disconnect();
    });
    this.hid = device;
    this.endpoint = next;
    // Find the framing this OS and transport want: only a correctly framed
    // request gets an answer, and a write "succeeding" proves nothing.
    for (const framing of FRAMINGS) {
      try {
        await this.send(RPC_METHODS.status, null, framing);
        this.framing = framing;
        break;
      } catch {
        this.consecutiveFailures = 0;
      }
    }
    if (!this.framing) {
      await this.disconnect();
      throw new Error("Codex Micro did not answer device.status in any framing");
    }
    this.log.info(
      `Codex Micro connected over ${next.transport} (${this.framing.report}${this.framing.crlf ? ", crlf" : ""})`,
    );
    this.setState({ ...DISCONNECTED, connected: true, transport: next.transport });
    this.applied = null;
    await this.flushLighting();
    await this.refreshStatus();
  }

  // Reconcile on every poll, even while connected: a Bluetooth handle can die
  // silently and plugging in the cable moves the device to its USB endpoint.
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const available = await listEndpoints();
      const topology = available.map((candidate) => candidate.path).join("\n");
      if (topology !== this.lastTopology) {
        this.lastTopology = topology;
        this.retryAt = 0;
      }
      const plan = reconcileEndpoint(this.hid ? this.endpoint : null, available);
      if (plan.keep) return;
      if (this.hid) await this.disconnect();
      if (!plan.next || Date.now() < this.retryAt) return;
      try {
        await this.connect(plan.next);
        this.lastError = null;
      } catch (error) {
        this.retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastError) {
        this.lastError = message;
        this.log.warn(`Codex Micro connection failed: ${message}`);
      }
    } finally {
      this.polling = false;
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
