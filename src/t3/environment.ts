import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type { Logger } from "../log.ts";
import { RpcConnection } from "./rpc.ts";
import type { Keybinding, ProjectShell, ProviderInfo, ThreadShell } from "./types.ts";

interface EnvironmentEvents {
  /** Threads, connection or config changed. */
  change: [];
}

export interface EnvironmentConfig {
  readonly environmentId: string;
  readonly label: string;
  readonly serverVersion: string;
  readonly keybindings: ReadonlyArray<Keybinding>;
  readonly providers: ReadonlyArray<ProviderInfo>;
  /** The "No project" workspace. */
  readonly scratchWorkspaceRoot: string | null;
}

export interface EnvironmentOptions {
  readonly url: string;
  readonly token: string;
  readonly log: Logger;
}

/**
 * One T3 Code server: its config (environment id, keybindings, providers)
 * and a live copy of the thread sidebar via `orchestration.subscribeShell`.
 */
export class T3Environment extends EventEmitter<EnvironmentEvents> {
  readonly rpc: RpcConnection;
  readonly threads = new Map<string, ThreadShell>();
  readonly projects = new Map<string, ProjectShell>();
  config: EnvironmentConfig | null = null;
  private sequence = -1;
  private synced = false;

  readonly options: EnvironmentOptions;

  constructor(options: EnvironmentOptions) {
    super();
    this.options = options;
    this.rpc = new RpcConnection(options);
    this.rpc.on("open", () => void this.loadConfig());
    this.rpc.on("close", () => {
      this.synced = false;
      this.emit("change");
    });
    this.rpc.subscribe("orchestration.subscribeShell", {}, (items) => this.applyItems(items));
  }

  get environmentId(): string | null {
    return this.config?.environmentId ?? null;
  }

  /** Connected and holding a current thread list. */
  get ready(): boolean {
    return this.rpc.isOpen && this.synced && this.config !== null;
  }

  start(): void {
    this.rpc.start();
  }

  stop(): void {
    this.rpc.stop();
  }

  private async loadConfig() {
    try {
      const value = await this.rpc.call<Record<string, any>>("server.getConfig", {});
      this.config = {
        environmentId: String(value.environment.environmentId),
        label: String(value.environment.label ?? ""),
        serverVersion: String(value.environment.serverVersion ?? ""),
        keybindings: Array.isArray(value.keybindings) ? value.keybindings : [],
        providers: Array.isArray(value.providers) ? value.providers : [],
        scratchWorkspaceRoot:
          typeof value.scratchWorkspaceRoot === "string" ? value.scratchWorkspaceRoot : null,
      };
      this.options.log.info(
        `environment ${this.config.label || this.config.environmentId} (T3 Code ${this.config.serverVersion})`,
      );
      this.emit("change");
    } catch (error) {
      this.options.log.warn("could not read T3 Code server config", error);
    }
  }

  private applyItems(items: unknown[]) {
    let changed = false;
    for (const raw of items) {
      const item = raw as Record<string, any>;
      switch (item.kind) {
        case "snapshot": {
          // A snapshot carrying resolvedRepositoryIdentityRoots only refreshes
          // projects; the plain one is authoritative for everything.
          const projects = item.snapshot.projects as ProjectShell[] | undefined;
          if (item.resolvedRepositoryIdentityRoots !== undefined) {
            for (const project of projects ?? []) this.projects.set(project.id, project);
            changed = true;
            break;
          }
          this.projects.clear();
          for (const project of projects ?? []) this.projects.set(project.id, project);
          this.threads.clear();
          for (const thread of item.snapshot.threads as ThreadShell[]) {
            this.threads.set(thread.id, thread);
          }
          this.sequence = item.snapshot.snapshotSequence;
          this.synced = true;
          changed = true;
          break;
        }
        case "thread.updated":
          if (item.sequence <= this.sequence) break;
          this.sequence = item.sequence;
          this.threads.set(item.thread.id, item.thread);
          changed = true;
          break;
        case "thread.removed":
          if (item.sequence <= this.sequence) break;
          this.sequence = item.sequence;
          changed = this.threads.delete(item.threadId) || changed;
          break;
        case "project.updated":
          if (item.sequence <= this.sequence) break;
          this.sequence = item.sequence;
          this.projects.set(item.project.id, item.project);
          changed = true;
          break;
        case "project.removed":
          if (item.sequence <= this.sequence) break;
          this.sequence = item.sequence;
          changed = this.projects.delete(item.projectId) || changed;
          break;
      }
    }
    if (changed) this.emit("change");
  }

  /** Sends one orchestration command; `commandId` is filled in. */
  async dispatch(command: Record<string, unknown> & { type: string }): Promise<unknown> {
    const full = { ...command, commandId: randomUUID() };
    this.options.log.debug(`dispatch ${command.type}`, command);
    return this.rpc.call("orchestration.dispatchCommand", full);
  }
}
