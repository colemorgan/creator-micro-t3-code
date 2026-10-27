import { execFile } from "node:child_process";

import type { Logger } from "../log.ts";
import type { ThreadRef } from "../model/slots.ts";
import { appleScriptKeystroke, appleScriptString, type Keystroke } from "./shortcut.ts";

/** What the bridge does in the desktop app itself (vs. server commands). */
export interface Host {
  /** Opens a thread in the app; `foreground` also raises the window. */
  openThread(ref: ThreadRef, foreground: boolean): Promise<void>;
  focusApp(): Promise<void>;
  /** Brings the app forward and presses `stroke` in it. */
  press(stroke: Keystroke): Promise<void>;
  startDictation(): Promise<void>;
  stopDictation(): Promise<void>;
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
    if bundle identifier of first application process whose frontmost is true is targetId then exit repeat
    delay 0.025
  end repeat
  set frontProcess to first application process whose frontmost is true
  if bundle identifier of frontProcess is not targetId then error "T3 Code did not come to the front"
  tell frontProcess
${body}
  end tell
end tell`;
    return run("/usr/bin/osascript", ["-e", script]);
  }

  async press(stroke: Keystroke): Promise<void> {
    await this.frontmost(`    ${appleScriptKeystroke(stroke)}`);
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

  async press(stroke: Keystroke): Promise<void> {
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
}

export function createHost(options: HostOptions): Host {
  return process.platform === "darwin" ? new MacHost(options) : new GenericHost(options);
}
