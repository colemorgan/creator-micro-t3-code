import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { LogLevel } from "./log.ts";
import type { AgentSource } from "./model/slots.ts";

/**
 * What a control does. Built-ins mirror the Codex Micro's factory actions;
 * `command:<id>` replays the T3 Code keybinding for that command (Settings →
 * Keybindings lists the ids) and `keys:<shortcut>` presses a literal
 * shortcut such as `keys:cmd+shift+e`.
 */
export type ActionName =
  | "none"
  | "fast"
  | "approve"
  | "approveForSession"
  | "decline"
  | "stop"
  | "fork"
  | "mic"
  | "send"
  | "togglePlanMode"
  | "increaseEffort"
  | "decreaseEffort"
  | "nextSlot"
  | "previousSlot"
  | "focusApp"
  | `command:${string}`
  | `keys:${string}`;

export type ControlId =
  | "ACT06"
  | "ACT07"
  | "ACT08"
  | "ACT09"
  | "ACT10"
  | "ACT12"
  | "JOY_UP"
  | "JOY_DOWN"
  | "JOY_LEFT"
  | "JOY_RIGHT";

export type KnobMode = "navigation" | "reasoning" | "agents";
export const KNOB_MODES: ReadonlyArray<KnobMode> = ["navigation", "reasoning", "agents"];

export interface EnvironmentEntry {
  /** Server origin, e.g. `http://100.64.0.1:3773`. */
  readonly url: string;
  /** Bearer token with `orchestration:read` and `orchestration:operate`. */
  readonly token: string;
}

export interface Config {
  readonly environments: ReadonlyArray<EnvironmentEntry>;
  /** The desktop app to drive: its name for `open -a`, and its URL scheme. */
  readonly app: { readonly name: string; readonly scheme: string };
  readonly agentSource: AgentSource;
  /** `environmentId/threadId` hard-assigned to agent keys 1–6. */
  readonly pins: ReadonlyArray<string | null>;
  readonly knobMode: KnobMode;
  readonly controls: Readonly<Record<ControlId, ActionName>>;
  /** 0–1. */
  readonly brightness: number;
  /** Lights off after this long without activity; null never dims. */
  readonly autoDimMs: number | null;
  /** How the Mic key records: macOS Dictation, or a dictation app's toggle shortcut. */
  readonly mic: { readonly mode: "dictation" | "shortcut"; readonly shortcut: string };
  /** The shortcut that sends the composer (T3 Code's default send shortcut is Enter). */
  readonly sendShortcut: string;
  readonly logLevel: LogLevel;
}

/** Codex Micro factory layout (FreeMicro docs/FACTORY-DEFAULTS.md §6–7). */
export const DEFAULT_CONTROLS: Readonly<Record<ControlId, ActionName>> = {
  ACT06: "fast",
  ACT07: "approve",
  ACT08: "decline",
  ACT09: "fork",
  ACT10: "mic",
  ACT12: "send",
  JOY_UP: "togglePlanMode",
  JOY_RIGHT: "command:navigation.forward",
  JOY_DOWN: "command:sidebar.toggle",
  JOY_LEFT: "command:navigation.back",
};

export const DEFAULT_CONFIG: Config = {
  environments: [],
  app: { name: "T3 Code (Beta)", scheme: "t3code" },
  agentSource: "recent",
  pins: [null, null, null, null, null, null],
  knobMode: "navigation",
  controls: DEFAULT_CONTROLS,
  brightness: 1,
  autoDimMs: 180_000,
  mic: { mode: "dictation", shortcut: "" },
  sendShortcut: "enter",
  logLevel: "info",
};

export const defaultConfigPath = () =>
  process.env.CODEX_MICRO_T3_CONFIG ?? join(homedir(), ".config", "codex-micro-t3", "config.json");

const AGENT_SOURCES: ReadonlyArray<AgentSource> = ["recent", "priority", "pinned"];

/** Reads the config, keeping defaults for anything missing or invalid. */
export function loadConfig(path = defaultConfigPath()): Config {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  const pick = <T>(value: unknown, valid: (v: any) => unknown, fallback: T): T =>
    valid(value) ? (value as T) : fallback;
  const controls: Record<ControlId, ActionName> = { ...DEFAULT_CONTROLS };
  for (const id of Object.keys(DEFAULT_CONTROLS) as ControlId[]) {
    if (typeof raw.controls?.[id] === "string") controls[id] = raw.controls[id] as ActionName;
  }
  return {
    environments: Array.isArray(raw.environments)
      ? raw.environments.filter(
          (entry: any) => typeof entry?.url === "string" && typeof entry?.token === "string",
        )
      : [],
    app: {
      name: pick(raw.app?.name, (v) => typeof v === "string" && v, DEFAULT_CONFIG.app.name),
      scheme: pick(raw.app?.scheme, (v) => typeof v === "string" && v, DEFAULT_CONFIG.app.scheme),
    },
    agentSource: pick(raw.agentSource, (v) => AGENT_SOURCES.includes(v), DEFAULT_CONFIG.agentSource),
    pins: Array.from({ length: 6 }, (_, index) =>
      typeof raw.pins?.[index] === "string" ? raw.pins[index] : null,
    ),
    knobMode: pick(raw.knobMode, (v) => KNOB_MODES.includes(v), DEFAULT_CONFIG.knobMode),
    controls,
    brightness: pick(
      raw.brightness,
      (v) => typeof v === "number" && v >= 0 && v <= 1,
      DEFAULT_CONFIG.brightness,
    ),
    autoDimMs: pick(
      raw.autoDimMs,
      (v) => v === null || (typeof v === "number" && v >= 1_000),
      DEFAULT_CONFIG.autoDimMs,
    ),
    mic: {
      mode: pick(raw.mic?.mode, (v) => v === "dictation" || v === "shortcut", "dictation"),
      shortcut: pick(raw.mic?.shortcut, (v) => typeof v === "string", ""),
    },
    sendShortcut: pick(raw.sendShortcut, (v) => typeof v === "string" && v, "enter"),
    logLevel: pick(
      raw.logLevel,
      (v) => ["debug", "info", "warn", "error"].includes(v),
      DEFAULT_CONFIG.logLevel,
    ),
  };
}

/** Writes the config with owner-only permissions: it holds bearer tokens. */
export function saveConfig(config: Config, path = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}
