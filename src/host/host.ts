import { execFile } from "node:child_process";

import type { Logger } from "../log.ts";
import type { ThreadRef } from "../model/slots.ts";
import { appleScriptString, holdKeyScript, type Keystroke, pressScript } from "./shortcut.ts";

/** What the bridge does in the desktop app itself (vs. server commands). */
export interface Host {
  /** Opens a thread in the app; `foreground` also raises the window. */
  openThread(ref: ThreadRef, foreground: boolean): Promise<void>;
  focusApp(): Promise<void>;
  /** Brings the app forward and presses `strokes` in it, in order. */
  press(...strokes: Keystroke[]): Promise<void>;
  startDictation(): Promise<void>;
  stopDictation(): Promise<void>;
  /** Holds (`down`) or releases a key system-wide, e.g. Fn for push-to-talk apps. */
  holdKey(stroke: Keystroke, down: boolean): Promise<void>;
}

export interface HostOptions {
  readonly appName: string;
  readonly scheme: string;
  readonly log: Logger;
}

const run = (file: string, args: string[], timeoutMs = 5_000) =>
  new Promise<string>((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve(stdout.trim());
    });
  });

export const threadUrl = (scheme: string, ref: ThreadRef) =>
  `${scheme}://threads/${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.threadId)}`;

/**
 * macOS: deep links through `open`, keystrokes and the Dictation menu through
 * System Events. Keystrokes need Accessibility permission for the process
 * running the bridge.
 */
export class MacHost implements Host {
  private readonly options: HostOptions;

  constructor(options: HostOptions) {
    this.options = options;
  }

  async openThread(ref: ThreadRef, foreground: boolean): Promise<void> {
    const url = threadUrl(this.options.scheme, ref);
    await run("/usr/bin/open", foreground ? [url] : ["-g", url]);
  }

  async focusApp(): Promise<void> {
    await run("/usr/bin/open", ["-a", this.options.appName]);
  }

  /** Activates the app and runs `body` inside System Events once it is frontmost. */
  private frontmost(body: string): Promise<string> {
    const app = appleScriptString(this.options.appName);
    // Never type into another app: bail out if activation didn't stick.
    const script = `
set targetId to id of application ${app}
tell application ${app} to activate
tell application "System Events"
  repeat 40 times
    if (bundle identifier of (first application process whose frontmost is true)) is targetId then exit repeat
    delay 0.025
  end repeat
  set frontProcess to (first application process whose frontmost is true)
  if (bundle identifier of frontProcess) is not targetId then error "T3 Code did not come to the front"
  tell frontProcess
${body}
  end tell
end tell`;
    return run("/usr/bin/osascript", ["-e", script]);
  }

  /** Where the app lives, for its bundle id. */
  private async appPath(): Promise<string> {
    this.resolvedPath ??= run("/usr/bin/osascript", [
      "-e",
      `POSIX path of (path to application ${appleScriptString(this.options.appName)})`,
    ]);
    return this.resolvedPath;
  }
  private resolvedPath: Promise<string> | undefined;

  // Key events are posted directly (CoreGraphics): System Events refuses
  // keystrokes from a background agent even with Accessibility granted.
  async press(...strokes: Keystroke[]): Promise<void> {
    const appPath = await this.appPath();
    await run("/usr/bin/open", ["-a", appPath]);
    await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", pressScript(strokes, appPath)]);
  }

  private dictationMenu(prefix: string): Promise<string> {
    return this.frontmost(`    set editMenu to menu 1 of (first menu bar item of menu bar 1 whose name is "Edit")
    click (first menu item of editMenu whose name starts with ${appleScriptString(prefix)})`);
  }

  async startDictation(): Promise<void> {
    await this.dictationMenu("Start Dictation");
  }

  async stopDictation(): Promise<void> {
    await this.dictationMenu("Stop Dictation").catch(async () => {
      // Dictation that already ended on its own leaves nothing to stop.
    });
  }

  async holdKey(stroke: Keystroke, down: boolean): Promise<void> {
    await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", holdKeyScript(stroke, down)]);
  }
}

/**
 * Linux and others: deep links through xdg-open; keystrokes through `wtype`
 * (Wayland) or `xdotool` (X11) when installed.
 */
export class GenericHost implements Host {
  private readonly options: HostOptions;

  constructor(options: HostOptions) {
    this.options = options;
  }

  async openThread(ref: ThreadRef): Promise<void> {
    await run("xdg-open", [threadUrl(this.options.scheme, ref)]);
  }

  async focusApp(): Promise<void> {
    this.options.log.debug("focusApp is not supported on this platform");
  }

  async press(...strokes: Keystroke[]): Promise<void> {
    for (const stroke of strokes) await this.pressOne(stroke);
  }

  private async pressOne(stroke: Keystroke): Promise<void> {
    const modifiers = [
      stroke.control && "ctrl",
      stroke.shift && "shift",
      stroke.option && "alt",
      stroke.command && "super",
    ].filter((name): name is string => Boolean(name));
    const xdoKey = { enter: "Return", escape: "Escape", arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right", tab: "Tab", space: "space" }[stroke.key] ?? stroke.key;
    if (process.env.WAYLAND_DISPLAY) {
      const args = modifiers.flatMap((name) => ["-M", name === "super" ? "logo" : name]);
      await run("wtype", [...args, "-k", xdoKey, ...modifiers.flatMap((name) => ["-m", name === "super" ? "logo" : name])]);
    } else {
      await run("xdotool", ["key", [...modifiers, xdoKey].join("+")]);
    }
  }

  async startDictation(): Promise<void> {
    throw new Error("Dictation is only supported on macOS; set mic.mode to \"shortcut\"");
  }

  async stopDictation(): Promise<void> {}

  async holdKey(): Promise<void> {
    throw new Error("Holding keys is only supported on macOS");
  }
}

export function createHost(options: HostOptions): Host {
  return process.platform === "darwin" ? new MacHost(options) : new GenericHost(options);
}
