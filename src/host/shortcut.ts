import type { Shortcut } from "../t3/types.ts";

export interface Keystroke {
  /** A printable key (lower case) or a named key such as `enter` or `arrowup`. */
  readonly key: string;
  readonly command: boolean;
  readonly control: boolean;
  readonly shift: boolean;
  readonly option: boolean;
}

const NAMED: Record<string, string> = {
  function: "fn",
  globe: "fn",
  return: "enter",
  esc: "escape",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  del: "delete",
  " ": "space",
};

const normalizeKey = (key: string) => {
  const lower = key.toLowerCase();
  return NAMED[lower] ?? lower;
};

/** Parses `cmd+shift+e` style shortcuts. `mod` is Command on macOS, Ctrl elsewhere. */
export function parseShortcut(text: string, mac = process.platform === "darwin"): Keystroke | null {
  const body = text.trim();
  let key: string | undefined;
  let modifiers: string[];
  if (body === "+") {
    key = "+";
    modifiers = [];
  } else if (body.endsWith("++")) {
    key = "+";
    modifiers = body.slice(0, -2).split("+");
  } else {
    modifiers = body.split("+");
    key = modifiers.pop();
  }
  if (!key) return null;
  const stroke = { key: normalizeKey(key), command: false, control: false, shift: false, option: false };
  for (const modifier of modifiers.map((part) => part.trim().toLowerCase())) {
    if (modifier === "cmd" || modifier === "command" || modifier === "meta") stroke.command = true;
    else if (modifier === "ctrl" || modifier === "control") stroke.control = true;
    else if (modifier === "shift") stroke.shift = true;
    else if (modifier === "alt" || modifier === "option" || modifier === "opt") stroke.option = true;
    else if (modifier === "mod") {
      if (mac) stroke.command = true;
      else stroke.control = true;
    } else return null;
  }
  return stroke;
}

/** A T3 Code keybinding as a keystroke. */
export function fromT3Shortcut(shortcut: Shortcut, mac = process.platform === "darwin"): Keystroke {
  return {
    key: normalizeKey(shortcut.key),
    command: shortcut.metaKey || (shortcut.modKey && mac),
    control: shortcut.ctrlKey || (shortcut.modKey && !mac),
    shift: shortcut.shiftKey,
    option: shortcut.altKey,
  };
}

// macOS virtual key codes for keys AppleScript can't type as text.
const MAC_KEY_CODES: Record<string, number> = {
  enter: 36,
  tab: 48,
  space: 49,
  backspace: 51,
  escape: 53,
  delete: 117,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  arrowleft: 123,
  arrowright: 124,
  arrowdown: 125,
  arrowup: 126,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

// Modifier keys post flagsChanged events with their flag set while held.
const MODIFIER_KEYS: Record<string, { code: number; flag: number }> = {
  fn: { code: 63, flag: 0x800000 },
  command: { code: 55, flag: 0x100000 },
  rightcommand: { code: 54, flag: 0x100000 },
  shift: { code: 56, flag: 0x20000 },
  rightshift: { code: 60, flag: 0x20000 },
  option: { code: 58, flag: 0x80000 },
  rightoption: { code: 61, flag: 0x80000 },
  control: { code: 59, flag: 0x40000 },
  rightcontrol: { code: 62, flag: 0x40000 },
};
const FLAGS = { command: 0x100000, shift: 0x20000, option: 0x80000, control: 0x40000 };

// US-layout virtual key codes for letters, digits and punctuation.
const LETTER_CODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15,
  y: 16, t: 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
  "-": 27, "8": 28, "0": 29, "]": 30, o: 31, u: 32, "[": 33, i: 34, p: 35, l: 37, j: 38, "'": 39,
  k: 40, ";": 41, "\\": 42, ",": 43, "/": 44, n: 45, m: 46, ".": 47, "`": 50,
};

function keyCodeOf(key: string): number {
  const code = MODIFIER_KEYS[key]?.code ?? MAC_KEY_CODES[key] ?? LETTER_CODES[key];
  if (code === undefined) throw new Error(`Unsupported key "${key}"`);
  return code;
}

const flagsOf = (stroke: Keystroke) =>
  (stroke.command ? FLAGS.command : 0) |
  (stroke.shift ? FLAGS.shift : 0) |
  (stroke.option ? FLAGS.option : 0) |
  (stroke.control ? FLAGS.control : 0);

// Events come from a HID-state source so they update the system's live
// modifier state: apps that poll it (Typeless watching Fn) see the key held.
const SOURCE = "const source = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);";

const postEvent = (code: number, down: boolean, flags: number) =>
  `{ const event = $.CGEventCreateKeyboardEvent(source, ${code}, ${down}); $.CGEventSetFlags(event, ${flags}); $.CGEventPost($.kCGHIDEventTap, event); }`;

/**
 * A JavaScript-for-Automation script that presses or releases `stroke` as a
 * low-level event, which global hotkey listeners (dictation apps) see. Plain
 * AppleScript can't hold a key down, and can't press Fn at all.
 */
export function holdKeyScript(stroke: Keystroke, down: boolean): string {
  const modifier = MODIFIER_KEYS[stroke.key];
  let flags = flagsOf(stroke);
  if (modifier && down) flags |= modifier.flag;
  return `ObjC.import("CoreGraphics");\n${SOURCE}\n${postEvent(keyCodeOf(stroke.key), down, flags)}`;
}

/**
 * Presses `strokes` in order in the app with this bundle path once it's
 * frontmost, pausing `gapSeconds` between them (menus need a moment to open),
 * and fails rather than typing into whatever else has focus.
 */
export function pressScript(strokes: ReadonlyArray<Keystroke>, appPath: string, gapSeconds = 0.12): string {
  const presses = strokes.map((stroke) => {
    const code = keyCodeOf(stroke.key);
    const flags = flagsOf(stroke);
    return `${postEvent(code, true, flags)}\n${postEvent(code, false, flags)}`;
  });
  return `ObjC.import("AppKit");
ObjC.import("CoreGraphics");
${SOURCE}
const target = $.NSBundle.bundleWithPath(${JSON.stringify(appPath)}).bundleIdentifier.js;
let front = false;
for (let i = 0; i < 60 && !front; i++) {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  front = !app.isNil() && app.bundleIdentifier.js === target;
  if (!front) delay(0.025);
}
if (!front) throw new Error("T3 Code did not come to the front");
${presses.join(`\ndelay(${gapSeconds});\n`)}`;
}

const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export const appleScriptString = quote;
