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

const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The System Events statement that presses `stroke`. */
export function appleScriptKeystroke(stroke: Keystroke): string {
  const modifiers = [
    stroke.command && "command down",
    stroke.control && "control down",
    stroke.shift && "shift down",
    stroke.option && "option down",
  ].filter(Boolean);
  const using = modifiers.length ? ` using {${modifiers.join(", ")}}` : "";
  const code = MAC_KEY_CODES[stroke.key];
  if (code !== undefined) return `key code ${code}${using}`;
  if ([...stroke.key].length !== 1) throw new Error(`Unsupported key "${stroke.key}"`);
  return `keystroke ${quote(stroke.key)}${using}`;
}

export const appleScriptString = quote;
