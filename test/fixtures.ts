import { EventEmitter } from "node:events";

import type { ThreadShell } from "../src/t3/types.ts";

export function thread(overrides: Partial<ThreadShell> = {}): ThreadShell {
  return {
    id: "t1",
    projectId: "p1",
    title: "Thread",
    providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [] },
    interactionMode: "default",
    lineage: { parentThreadId: null, relationshipToParent: null },
    latestRunId: "run-1",
    latestRunCompletedAt: null,
    activeRunId: null,
    activeProviderThreadId: "pt",
    status: "completed",
    pendingRuntimeRequest: null,
    pendingGuestMessageCount: 0,
    updatedAt: "2026-10-27T10:00:00Z",
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    lastVisitedAt: null,
    ...overrides,
  };
}

/** Stands in for `T3Environment` in controller tests. */
export class FakeEnvironment extends EventEmitter {
  readonly threads = new Map<string, ThreadShell>();
  readonly dispatched: Array<Record<string, unknown>> = [];
  config: any;
  readonly environmentId: string;

  constructor(
    environmentId: string,
    threads: ThreadShell[],
    config: Partial<{ keybindings: any[]; providers: any[] }> = {},
  ) {
    super();
    this.environmentId = environmentId;
    for (const entry of threads) this.threads.set(entry.id, entry);
    this.config = {
      environmentId,
      label: environmentId,
      serverVersion: "0.1.3",
      keybindings: config.keybindings ?? [],
      providers: config.providers ?? [],
    };
  }

  async dispatch(command: Record<string, unknown>) {
    this.dispatched.push(command);
    return { sequence: this.dispatched.length };
  }
}

export class FakeHost {
  readonly calls: string[] = [];
  async openThread(ref: { environmentId: string; threadId: string }, foreground: boolean) {
    this.calls.push(`open ${ref.threadId}${foreground ? " foreground" : ""}`);
  }
  async focusApp() {
    this.calls.push("focus");
  }
  async press(stroke: { key: string; command: boolean; control: boolean; shift: boolean }) {
    // Report T3's "mod" the same way on every platform.
    const mod = stroke.command || stroke.control ? "cmd+" : "";
    this.calls.push(`press ${mod}${stroke.shift ? "shift+" : ""}${stroke.key}`);
  }
  async startDictation() {
    this.calls.push("dictation start");
  }
  async stopDictation() {
    this.calls.push("dictation stop");
  }
}

export class FakeLights {
  readonly frames: unknown[] = [];
  async setLighting(frame: unknown) {
    this.frames.push(frame);
  }
  invalidateLighting() {}
}
