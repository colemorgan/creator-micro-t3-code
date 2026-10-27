// Maps what the bridge wants shown to the firmware's two lighting calls,
// following the Codex app's factory behaviour (documented by FreeMicro,
// docs/FACTORY-DEFAULTS.md): solid status colours, the selected key breathes,
// the key backlight stays dark, and the ambient ring only lights for voice,
// a working selected thread, or a brief flash after the selection moves.

export type SlotStatus = "off" | "idle" | "working" | "needs-input" | "done" | "error";
export type VoiceState = "idle" | "recording" | "processing" | "completed";

/** Codex Micro's status colours (packed RGB). */
export const STATUS_COLORS: Readonly<Record<Exclude<SlotStatus, "off">, number>> = {
  idle: 0xffffff,
  working: 0x304ffe,
  done: 0x00ff4c,
  "needs-input": 0xff6d00,
  error: 0xff0033,
};

const VOICE_COLORS = { recording: 0x2e8b57, processing: 0xffffff, completed: 0xffffff } as const;

// Firmware effect codes.
export const EFFECT = { off: 0, solid: 1, snake: 2, breath: 4, shallowBreath: 6 } as const;

export interface Zone {
  readonly e: number;
  readonly b: number;
  readonly s: number;
  readonly m: number;
  readonly c: number;
}

export interface SlotLight {
  readonly id: number;
  readonly c: number;
  readonly b: number;
  readonly e: number;
  readonly s: number;
  readonly sk: 0;
  readonly sa: 0;
}

export interface LightingFrame {
  /** `v.oai.rgbcfg` params. */
  readonly zones: { readonly keys: Zone; readonly ambient: Zone };
  /** `v.oai.thstatus` params. */
  readonly slots: ReadonlyArray<SlotLight>;
}

export const ZONE_OFF: Zone = { e: EFFECT.off, b: 0, s: 0, m: 0, c: 0 };

/** A short ambient (and optionally key) flash the bridge uses for feedback. */
export interface Flash {
  readonly color: number;
  readonly effect: number;
  readonly keys: boolean;
}

export interface LightingModel {
  readonly slots: ReadonlyArray<{ readonly status: SlotStatus; readonly selected: boolean }>;
  /** 0–1, applied to every zone. */
  readonly brightness: number;
  readonly voice: VoiceState;
  /** True for a few seconds after the selected key changes. */
  readonly selectionFlash: boolean;
  /** Feedback such as "nothing to approve" or a knob mode change. Wins over everything. */
  readonly flash: Flash | null;
}

export const DARK_FRAME: LightingFrame = {
  zones: { keys: ZONE_OFF, ambient: ZONE_OFF },
  slots: Array.from({ length: 6 }, (_, id) => ({ id, c: 0, b: 0, e: 0, s: 0, sk: 0, sa: 0 })),
};

export function lightingFrame(model: LightingModel): LightingFrame {
  const brightness = Math.min(1, Math.max(0, model.brightness));
  const slots = Array.from({ length: 6 }, (_, id): SlotLight => {
    const slot = model.slots[id];
    if (!slot || slot.status === "off") return { id, c: 0, b: 0, e: 0, s: 0, sk: 0, sa: 0 };
    return {
      id,
      c: STATUS_COLORS[slot.status],
      b: brightness,
      e: slot.selected ? EFFECT.breath : EFFECT.solid,
      s: slot.selected ? 0.4 : 0,
      sk: 0,
      sa: 0,
    };
  });

  const selected = model.slots.find((slot) => slot.selected && slot.status !== "off");
  const selectedColor = selected ? STATUS_COLORS[selected.status as Exclude<SlotStatus, "off">] : 0;
  let ambient: Zone = ZONE_OFF;
  let keys: Zone = ZONE_OFF;
  if (model.flash) {
    ambient = { e: model.flash.effect, b: brightness, s: 0.6, m: 0, c: model.flash.color };
    if (model.flash.keys) keys = { e: EFFECT.solid, b: brightness, s: 0, m: 0, c: model.flash.color };
  } else if (model.voice !== "idle") {
    ambient = {
      e: model.voice === "completed" ? EFFECT.solid : EFFECT.snake,
      b: brightness,
      s: model.voice === "completed" ? 0 : 0.4,
      m: 0,
      c: VOICE_COLORS[model.voice],
    };
  } else if (selected?.status === "working") {
    ambient = { e: EFFECT.snake, b: brightness, s: 0.4, m: 0, c: selectedColor };
  } else if (selected && model.selectionFlash) {
    ambient = { e: EFFECT.solid, b: brightness, s: 0, m: 0, c: selectedColor };
  }
  if (!model.flash && selected && model.selectionFlash) {
    keys = { e: EFFECT.solid, b: brightness, s: 0, m: 0, c: ambient.c || selectedColor };
  }
  return { zones: { keys, ambient }, slots };
}
