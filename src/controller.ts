import { randomUUID } from "node:crypto";

import type { ActionName, Config, ControlId, KnobMode } from "./config.ts";
import { KNOB_MODES } from "./config.ts";
import type { DeviceInput } from "./device/device.ts";
import {
  DARK_FRAME,
  EFFECT,
  type Flash,
  type LightingFrame,
  lightingFrame,
  STATUS_COLORS,
  type VoiceState,
} from "./device/lighting.ts";
import type { Host } from "./host/host.ts";
import { fromT3Shortcut, parseShortcut, type Keystroke } from "./host/shortcut.ts";
import type { Logger } from "./log.ts";
import {
  assignSlots,
  candidateThreads,
  EMPTY_SLOTS,
  hasPendingApproval,
  isWorking,
  refKey,
  sameRef,
  type Slot,
  type ThreadRef,
} from "./model/slots.ts";
import type { T3Environment } from "./t3/environment.ts";
import type { OptionDescriptor, ThreadShell } from "./t3/types.ts";

// Factory timings (FreeMicro docs/FACTORY-DEFAULTS.md).
export const DOUBLE_TAP_MS = 350;
const KNOB_HOLD_MS = 500;
const SELECTION_FLASH_MS = 4_000;
const INPUT_QUIET_MS = 100;
const JOYSTICK_TRIGGER = 0.5;
const JOYSTICK_RELEASE = 0.1;
const VOICE_COMPLETED_MS = 1_000;
const FEEDBACK_MS = 450;

const AGENT_KEY = /^AG0([0-5])$/;
const UNAVAILABLE: Flash = { color: STATUS_COLORS.error, effect: EFFECT.solid, keys: false };
const KNOB_MODE_COLORS: Record<KnobMode, number> = {
  navigation: 0xffffff,
  reasoning: 0xb388ff,
  agents: STATUS_COLORS.working,
};

/** What the controller needs from the device. */
export interface LightSink {
  setLighting(frame: LightingFrame): Promise<void>;
  invalidateLighting(): void;
}

export type Clock = { now(): number };

export function joystickDirection(angle: number): "JOY_UP" | "JOY_DOWN" | "JOY_LEFT" | "JOY_RIGHT" {
  if (angle >= 0.625 && angle < 0.875) return "JOY_UP";
  if (angle >= 0.125 && angle < 0.375) return "JOY_DOWN";
  if (angle >= 0.375 && angle < 0.625) return "JOY_LEFT";
  return "JOY_RIGHT";
}

type MicState =
  | { kind: "idle" }
  | { kind: "pressed"; at: number }
  | { kind: "waiting"; timer: NodeJS.Timeout }
  | { kind: "latched" }
  | { kind: "suppressing"; until: number };

/**
 * Drives a Codex Micro from T3 Code: agent keys mirror six threads across
 * every connected environment, command keys act on the selected thread.
 */
export class Controller {
  slots: ReadonlyArray<Slot> = EMPTY_SLOTS;
  selected: ThreadRef | null = null;
  knobMode: KnobMode;
  /** The T3 Code sidebar's project filter key, or null for all projects. */
  scope: string | null = null;
  private selectedAt = 0;
  private selectionChangedAt = 0;
  private voice: VoiceState = "idle";
  private flash: Flash | null = null;
  private flashTimer: NodeJS.Timeout | null = null;
  private lastTap: { index: number; key: string; at: number } | null = null;
  private knobHold: { timer: NodeJS.Timeout; fired: boolean } | null = null;
  private joystickArmed = true;
  private mic: MicState = { kind: "idle" };
  private voiceTimer: NodeJS.Timeout | null = null;
  private lastInputAt = 0;
  private pushTimer: NodeJS.Timeout | null = null;
  private selectionTimer: NodeJS.Timeout | null = null;
  private dimTimer: NodeJS.Timeout | null = null;
  private dimmed = false;
  private lastModel = "";
  /** Fast mode as last set from the keyboard, per thread. */
  private readonly fastState = new Map<string, boolean>();

  private readonly config: Config;
  private readonly environments: ReadonlyArray<T3Environment>;
  private readonly lights: LightSink;
  private readonly host: Host;
  private readonly log: Logger;
  private readonly clock: Clock;

  constructor(
    config: Config,
    environments: ReadonlyArray<T3Environment>,
    lights: LightSink,
    host: Host,
    log: Logger,
    clock: Clock = Date,
  ) {
    this.config = config;
    this.environments = environments;
    this.lights = lights;
    this.host = host;
    this.log = log;
    this.clock = clock;
    this.knobMode = config.knobMode;
    for (const environment of environments) environment.on("change", () => this.refresh());
  }

  // ---------------------------------------------------------------------------
  // State → lights

  /** Recomputes the agent keys from the latest thread lists. */
  refresh(): void {
    const ready = this.environments.filter((environment) => environment.environmentId);
    const threads = candidateThreads(
      ready.map((environment) => ({
        environmentId: environment.environmentId!,
        threads: environment.threads.values(),
        projects: environment.projects.values(),
        scratchWorkspaceRoot: environment.config?.scratchWorkspaceRoot ?? null,
      })),
      new Date(this.clock.now()).toISOString(),
      this.config.followSidebar ? { scope: this.scope, hideSettled: true } : {},
    );
    this.slots = assignSlots({
      threads,
      previous: this.slots,
      source: this.config.agentSource,
      pins: this.config.pins,
    });
    this.followAppSelection(threads.map((entry) => entry));
    this.render();
  }

  /**
   * The app marks a thread visited when you open it, so the most recent visit
   * is the thread on screen. Follow it unless a key press is more recent.
   */
  private followAppSelection(threads: ReadonlyArray<ThreadRef & { thread: ThreadShell }>) {
    let latest: (ThreadRef & { at: number }) | null = null;
    for (const entry of threads) {
      const at = Date.parse(entry.thread.lastVisitedAt ?? "");
      if (!Number.isNaN(at) && (!latest || at > latest.at)) {
        latest = { environmentId: entry.environmentId, threadId: entry.threadId, at };
      }
    }
    if (latest && latest.at > this.selectedAt && !sameRef(latest, this.selected)) {
      this.select(latest, latest.at);
    } else if (latest && latest.at > this.selectedAt) {
      this.selectedAt = latest.at;
    }
  }

  /** Follows the sidebar's project filter. */
  setScope(scope: string | null): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.refresh();
  }

  private select(ref: ThreadRef | null, at = this.clock.now()) {
    const changed = !sameRef(ref, this.selected);
    this.selected = ref;
    this.selectedAt = Math.max(this.selectedAt, at);
    if (!changed) return;
    this.selectionChangedAt = this.clock.now();
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => this.render(), SELECTION_FLASH_MS + 10);
  }

  private get selectedSlot(): Slot | undefined {
    return this.slots.find((slot) => sameRef(slot.ref, this.selected));
  }

  frame(): LightingFrame {
    return lightingFrame({
      slots: this.slots.map((slot) => ({
        status: slot.status,
        selected: sameRef(slot.ref, this.selected),
      })),
      brightness: this.config.brightness,
      voice: this.voice,
      selectionFlash:
        this.selectionChangedAt > 0 &&
        this.clock.now() - this.selectionChangedAt < SELECTION_FLASH_MS,
      flash: this.flash,
    });
  }

  /** Pushes lighting, coalescing writes while keys are being pressed. */
  render(): void {
    const frame = this.frame();
    const key = JSON.stringify(frame);
    // Only a change in what's shown counts as activity for auto-dim.
    if (key !== this.lastModel) {
      this.lastModel = key;
      this.wake();
    }
    if (this.dimmed) return;
    const quiet = this.clock.now() - this.lastInputAt;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(
      () => {
        this.pushTimer = null;
        if (!this.dimmed) void this.lights.setLighting(this.frame());
      },
      Math.max(0, INPUT_QUIET_MS - quiet),
    );
  }

  /** Restores the lights and restarts the auto-dim timer. */
  private wake() {
    if (this.dimTimer) clearTimeout(this.dimTimer);
    this.dimTimer = null;
    if (this.config.autoDimMs !== null) {
      this.dimTimer = setTimeout(() => {
        this.dimmed = true;
        this.lights.invalidateLighting();
        void this.lights.setLighting(DARK_FRAME);
      }, this.config.autoDimMs);
    }
    if (this.dimmed) {
      this.dimmed = false;
      this.lights.invalidateLighting();
      void this.lights.setLighting(this.frame());
    }
  }

  private showFlash(flash: Flash, ms = FEEDBACK_MS) {
    this.flash = flash;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flash = null;
      this.render();
    }, ms);
    this.render();
  }

  private unavailable(reason: string) {
    this.log.info(`unavailable: ${reason}`);
    this.showFlash(UNAVAILABLE);
  }

  /** Re-sends lighting after the device reconnects. */
  deviceConnected(): void {
    this.lights.invalidateLighting();
    this.wake();
    void this.lights.setLighting(this.frame());
  }

  /** Lets go of a key held for push-to-talk, e.g. when the bridge stops. */
  async releaseHeldKeys(): Promise<void> {
    if (this.voice !== "recording" || this.config.mic.mode !== "hold") return;
    this.voice = "idle";
    this.mic = { kind: "idle" };
    await this.holdKey(this.config.mic.shortcut, false).catch(() => {});
  }

  dispose(): void {
    for (const timer of [
      this.flashTimer,
      this.pushTimer,
      this.selectionTimer,
      this.dimTimer,
      this.voiceTimer,
      this.knobHold?.timer ?? null,
    ]) {
      if (timer) clearTimeout(timer);
    }
    if (this.mic.kind === "waiting") clearTimeout(this.mic.timer);
  }

  // ---------------------------------------------------------------------------
  // Input

  handleInput(input: DeviceInput): void {
    if (input.type === "joystick") {
      if (input.distance > 0.1) this.activity();
      if (input.distance <= JOYSTICK_RELEASE) this.joystickArmed = true;
      else if (this.joystickArmed && input.distance >= JOYSTICK_TRIGGER) {
        this.joystickArmed = false;
        this.runControl(joystickDirection(input.angle));
      }
      return;
    }
    this.activity();
    const { key, act } = input;
    const agent = AGENT_KEY.exec(key);
    if (agent) {
      if (act === 1) this.tapAgentKey(Number(agent[1]));
      return;
    }
    if (key === "ENC_CW" || key === "ENC_CC") {
      if (act === 2 || act === 1) this.turnKnob(key === "ENC_CW" ? 1 : -1);
      return;
    }
    if (key.startsWith("ENC")) {
      this.pressKnob(act);
      return;
    }
    // One wide keycap covers ACT10 + ACT11 and both switches fire; ACT10 acts.
    if (key === "ACT11") return;
    if (key === "ACT10" && this.config.controls.ACT10 === "mic") {
      if (act === 1) this.micPress();
      else if (act === 0) this.micRelease();
      return;
    }
    if (act === 1 && key in this.config.controls) this.runControl(key as ControlId);
  }

  private activity() {
    this.lastInputAt = this.clock.now();
    this.wake();
  }

  private tapAgentKey(index: number) {
    const slot = this.slots[index];
    if (!slot?.ref) return;
    const now = this.clock.now();
    const key = refKey(slot.ref);
    const previous = this.lastTap;
    const doubleTap =
      previous?.index === index && previous.key === key && now - previous.at <= DOUBLE_TAP_MS;
    this.lastTap = doubleTap ? null : { index, key, at: now };
    this.openRef(slot.ref, doubleTap);
  }

  private openRef(ref: ThreadRef, foreground: boolean) {
    this.select(ref);
    this.render();
    this.host
      .openThread(ref, foreground)
      .catch((error) => this.log.warn("could not open thread", error));
  }

  private stepSlot(step: 1 | -1) {
    const filled = this.slots.filter((slot) => slot.ref);
    if (filled.length === 0) return this.unavailable("no agent keys are assigned");
    const position = filled.findIndex((slot) => sameRef(slot.ref, this.selected));
    const next =
      position === -1
        ? filled[step === 1 ? 0 : filled.length - 1]!
        : filled[(position + step + filled.length) % filled.length]!;
    this.openRef(next.ref!, false);
  }

  private turnKnob(direction: 1 | -1) {
    // Factory: clockwise is "previous"/up and "decrease reasoning".
    switch (this.knobMode) {
      case "navigation":
        return this.runAction(direction === 1 ? "keys:arrowup" : "keys:arrowdown");
      case "reasoning":
        return this.runAction(direction === 1 ? "decreaseEffort" : "increaseEffort");
      case "agents":
        return this.stepSlot(direction === 1 ? 1 : -1);
    }
  }

  private pressKnob(act: number | null) {
    if (act === 1 && this.knobHold === null) {
      const hold = {
        fired: false,
        timer: setTimeout(() => {
          hold.fired = true;
          this.cycleKnobMode();
        }, KNOB_HOLD_MS),
      };
      this.knobHold = hold;
    } else if (act === 0 && this.knobHold !== null) {
      const hold = this.knobHold;
      this.knobHold = null;
      clearTimeout(hold.timer);
      if (!hold.fired) this.clickKnob();
    }
  }

  private clickKnob() {
    switch (this.knobMode) {
      case "navigation":
        return this.runAction("keys:enter");
      case "reasoning":
        return this.runAction("command:composer.effort");
      case "agents":
        return this.runAction("focusApp");
    }
  }

  /** Holding the knob switches what turning it does, shown in the ring's colour. */
  private cycleKnobMode() {
    const next = KNOB_MODES[(KNOB_MODES.indexOf(this.knobMode) + 1) % KNOB_MODES.length]!;
    this.knobMode = next;
    this.log.info(`knob mode: ${next}`);
    this.showFlash({ color: KNOB_MODE_COLORS[next], effect: EFFECT.solid, keys: true }, 900);
  }

  // Push to talk, as the factory MIC key: hold to record, or double-tap to
  // keep recording and tap again to stop.
  private micPress() {
    const now = this.clock.now();
    switch (this.mic.kind) {
      case "idle":
        this.mic = { kind: "pressed", at: now };
        return this.setRecording(true);
      case "waiting":
        clearTimeout(this.mic.timer);
        this.mic = { kind: "latched" };
        return;
      case "latched":
        this.mic = { kind: "suppressing", until: now + DOUBLE_TAP_MS };
        return this.setRecording(false);
      case "suppressing":
        if (now < this.mic.until) return;
        this.mic = { kind: "pressed", at: now };
        return this.setRecording(true);
      case "pressed":
        return;
    }
  }

  private micRelease() {
    if (this.mic.kind !== "pressed") return;
    const held = this.clock.now() - this.mic.at;
    if (held >= DOUBLE_TAP_MS) {
      this.mic = { kind: "idle" };
      return this.setRecording(false);
    }
    const timer = setTimeout(() => {
      this.mic = { kind: "idle" };
      this.setRecording(false);
    }, DOUBLE_TAP_MS - held);
    this.mic = { kind: "waiting", timer };
  }

  private setRecording(recording: boolean) {
    if (this.voiceTimer) clearTimeout(this.voiceTimer);
    this.voice = recording ? "recording" : "completed";
    if (!recording) {
      this.voiceTimer = setTimeout(() => {
        this.voice = "idle";
        this.render();
      }, VOICE_COMPLETED_MS);
    }
    this.render();
    const { mic } = this.config;
    const task =
      mic.mode === "shortcut"
        ? this.pressShortcut(mic.shortcut)
        : mic.mode === "hold"
          ? this.holdKey(mic.shortcut, recording)
          : recording
            ? this.host.startDictation()
            : this.host.stopDictation();
    task.catch((error) => {
      this.log.warn(`could not ${recording ? "start" : "stop"} dictation`, error);
      if (recording) {
        this.voice = "idle";
        this.mic = { kind: "idle" };
        if (mic.mode === "hold") void this.holdKey(mic.shortcut, false).catch(() => {});
        this.unavailable("dictation failed");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Actions

  runControl(control: ControlId): void {
    this.runAction(this.config.controls[control] ?? "none");
  }

  runAction(action: ActionName): void {
    this.log.debug(`action ${action}`);
    this.perform(action).catch((error) => {
      this.log.warn(`${action} failed`, error);
      this.showFlash(UNAVAILABLE);
    });
  }

  private environmentOf(ref: ThreadRef | null): T3Environment | undefined {
    return ref
      ? this.environments.find((environment) => environment.environmentId === ref.environmentId)
      : undefined;
  }

  private threadOf(ref: ThreadRef | null): { environment: T3Environment; thread: ThreadShell } | null {
    const environment = this.environmentOf(ref);
    const thread = ref ? environment?.threads.get(ref.threadId) : undefined;
    return environment && thread ? { environment, thread } : null;
  }

  /** The selected thread first, then the other agent keys, without duplicates. */
  private keyThreads() {
    const refs = [this.selected, ...this.slots.map((slot) => slot.ref)];
    const seen = new Set<string>();
    return refs.flatMap((ref) => {
      if (!ref || seen.has(refKey(ref))) return [];
      seen.add(refKey(ref));
      const found = this.threadOf(ref);
      return found ? [found] : [];
    });
  }

  /**
   * The thread a command key acts on: the selected one if it qualifies,
   * otherwise the only key thread that does. Never guesses between several.
   */
  private target(qualifies: (thread: ThreadShell) => boolean) {
    const selected = this.threadOf(this.selected);
    if (selected && qualifies(selected.thread)) return selected;
    const matches = this.keyThreads().filter((entry) => qualifies(entry.thread));
    return matches.length === 1 ? matches[0]! : null;
  }

  private async perform(action: ActionName): Promise<void> {
    if (action.startsWith("command:")) return this.runCommand(action.slice("command:".length));
    if (action.startsWith("keys:")) return this.pressShortcut(action.slice("keys:".length));
    switch (action) {
      case "none":
        return;
      case "focusApp":
        return this.host.focusApp();
      case "nextSlot":
        return this.stepSlot(1);
      case "previousSlot":
        return this.stepSlot(-1);
      case "send":
        return this.pressShortcut(this.config.sendShortcut);
      case "mic":
        // Reached only when Mic is bound to a key other than the wide one.
        return this.setRecording(this.voice !== "recording");
      case "approve":
      case "approveForSession":
      case "decline": {
        const target = this.target(hasPendingApproval);
        if (!target) return this.unavailable("no approval waiting");
        await target.environment.dispatch({
          type: "runtime-request.respond",
          threadId: target.thread.id,
          requestId: target.thread.pendingRuntimeRequest!.id,
          decision:
            action === "approve" ? "accept" : action === "decline" ? "decline" : "acceptForSession",
        });
        return;
      }
      case "stop": {
        const target = this.target(isWorking);
        if (!target) return this.unavailable("nothing running to stop");
        const runId = target.thread.activeRunId ?? target.thread.latestRunId;
        await target.environment.dispatch(
          runId
            ? { type: "run.interrupt", threadId: target.thread.id, runId, holdQueue: true }
            : { type: "thread.stop", threadId: target.thread.id },
        );
        return;
      }
      case "fork": {
        const target = this.threadOf(this.selected);
        if (!target?.thread.latestRunId) return this.unavailable("no thread to fork");
        const targetThreadId = randomUUID();
        await target.environment.dispatch({
          type: "thread.fork",
          createdBy: "user",
          creationSource: "web",
          sourceThreadId: target.thread.id,
          targetThreadId,
          sourcePoint: { type: "run", runId: target.thread.latestRunId },
        });
        this.openRef({ environmentId: target.environment.environmentId!, threadId: targetThreadId }, true);
        return;
      }
      case "togglePlanMode": {
        const target = this.threadOf(this.selected);
        if (!target) return this.unavailable("no thread selected");
        const interactionMode = target.thread.interactionMode === "plan" ? "default" : "plan";
        await target.environment.dispatch({
          type: "thread.interaction-mode.set",
          threadId: target.thread.id,
          interactionMode,
        });
        this.showFlash({
          color: interactionMode === "plan" ? 0x40c4ff : 0xffffff,
          effect: EFFECT.solid,
          keys: false,
        });
        return;
      }
      case "fast":
        return this.toggleFast();
      case "increaseEffort":
        return this.stepEffort(1);
      case "decreaseEffort":
        return this.stepEffort(-1);
    }
  }

  private shortcutFor(command: string): Keystroke | null {
    const environment =
      this.environmentOf(this.selected) ?? this.environments.find((candidate) => candidate.config);
    const binding = environment?.config?.keybindings.find((entry) => entry.command === command);
    return binding ? fromT3Shortcut(binding.shortcut) : null;
  }

  private async runCommand(command: string): Promise<void> {
    const stroke = this.shortcutFor(command);
    if (!stroke) return this.unavailable(`no shortcut is bound to ${command}`);
    await this.host.press(stroke);
  }

  private async holdKey(text: string, down: boolean): Promise<void> {
    const stroke = parseShortcut(text);
    if (!stroke) throw new Error(`unrecognized key "${text}"`);
    await this.host.holdKey(stroke, down);
  }

  private async pressShortcut(text: string): Promise<void> {
    const stroke: Keystroke | null = parseShortcut(text);
    if (!stroke) return this.unavailable(`unrecognized shortcut "${text}"`);
    await this.host.press(stroke);
  }

  private modelOptions(environment: T3Environment, thread: ThreadShell): ReadonlyArray<OptionDescriptor> {
    const { instanceId, model } = thread.modelSelection;
    const provider = environment.config?.providers.find((entry) => entry.instanceId === instanceId);
    const entry = provider?.models.find((candidate) => (candidate.slug ?? candidate.id) === model);
    return entry?.capabilities?.optionDescriptors ?? [];
  }

  private async setOption(
    environment: T3Environment,
    thread: ThreadShell,
    id: string,
    value: string | boolean,
  ): Promise<void> {
    const options = (thread.modelSelection.options ?? []).filter((option) => option.id !== id);
    await environment.dispatch({
      type: "thread.model-selection.set",
      threadId: thread.id,
      modelSelection: { ...thread.modelSelection, options: [...options, { id, value }] },
    });
  }

  private currentValue(thread: ThreadShell, descriptor: OptionDescriptor): string | boolean | undefined {
    return (
      thread.modelSelection.options?.find((option) => option.id === descriptor.id)?.value ??
      descriptor.options?.find((option) => option.isDefault)?.id ??
      descriptor.currentValue
    );
  }

  /**
   * Fast mode: Claude's `fastMode` switch, or Codex's priority service tier.
   * The composer keeps its own copy of these options once you've touched its
   * picker, so the change is made there too: Fast is the last group of the
   * effort menu, reached with End and stepped to with ArrowUp.
   */
  private async toggleFast(): Promise<void> {
    const target = this.threadOf(this.selected);
    if (!target) return this.unavailable("no thread selected");
    const key = refKey(this.selected!);
    const descriptors = this.modelOptions(target.environment, target.thread);
    const boolean = descriptors.find((d) => d.type === "boolean" && /fast/i.test(`${d.id} ${d.label ?? ""}`));
    let enabled: boolean;
    let stepsUp: number;
    if (boolean) {
      enabled = !(this.fastState.get(key) ?? this.currentValue(target.thread, boolean) === true);
      // Menu items: On, Off.
      stepsUp = enabled ? 1 : 0;
      await this.setOption(target.environment, target.thread, boolean.id, enabled);
    } else {
      const tier = descriptors.find(
        (d) => d.type === "select" && d.options?.some((o) => o.id === "priority" || /^fast$/i.test(o.label ?? "")),
      );
      if (!tier) return this.unavailable("this model has no fast mode");
      const options = tier.options!;
      const fast = options.find((o) => o.id === "priority" || /^fast$/i.test(o.label ?? ""))!;
      const normal = options.find((o) => o.isDefault) ?? options[0]!;
      enabled = !(this.fastState.get(key) ?? this.currentValue(target.thread, tier) === fast.id);
      const choice = enabled ? fast : normal;
      stepsUp = options.length - 1 - options.indexOf(choice);
      await this.setOption(target.environment, target.thread, tier.id, choice.id);
    }
    this.fastState.set(key, enabled);
    this.showFlash({ color: enabled ? 0xffd600 : 0x555555, effect: EFFECT.solid, keys: false });
    const effort = this.shortcutFor("composer.effort");
    if (!effort) return;
    const arrow = parseShortcut("arrowup")!;
    await this.host.press(
      effort,
      parseShortcut("end")!,
      ...Array.from({ length: stepsUp }, () => arrow),
      parseShortcut("enter")!,
    );
  }

  private async stepEffort(step: 1 | -1): Promise<void> {
    const target = this.threadOf(this.selected);
    if (!target) return this.unavailable("no thread selected");
    const descriptor = this.modelOptions(target.environment, target.thread).find(
      (d) =>
        d.type === "select" &&
        (/^(effort|reasoningEffort|reasoning_effort)$/.test(d.id) || /reasoning/i.test(d.label ?? "")),
    );
    const levels = descriptor?.options ?? [];
    if (!descriptor || levels.length === 0) return this.unavailable("this model has no effort levels");
    const current = this.currentValue(target.thread, descriptor);
    const index = Math.max(0, levels.findIndex((level) => level.id === current));
    const next = levels[Math.min(levels.length - 1, Math.max(0, index + step))]!;
    if (next.id === current) return this.unavailable(`effort is already ${next.label ?? next.id}`);
    await this.setOption(target.environment, target.thread, descriptor.id, next.id);
    this.log.info(`effort: ${next.label ?? next.id}`);
    // Brighter purple for higher effort.
    const share = levels.indexOf(next) / Math.max(1, levels.length - 1);
    const level = Math.round(0x40 + share * 0xbf);
    this.showFlash({ color: (level << 16) | (0x30 << 8) | 0xff, effect: EFFECT.solid, keys: false });
  }
}
