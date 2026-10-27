import { EventEmitter } from "node:events";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Logger } from "../log.ts";

// The desktop app keeps its sidebar's project filter (`sidebarProjectScopeKey`)
// in its renderer's localStorage, which Chromium stores as LevelDB. New writes
// are appended to the `.log` file uncompressed, so the latest value is the
// last occurrence there; the app rewrites its UI state on every visit, so one
// is almost always present. Values are Latin-1 or UTF-16LE depending on content.

const FIELD = '"sidebarProjectScopeKey":';
const NEEDLES = [
  { encoding: "latin1" as const, bytes: Buffer.from(FIELD, "latin1") },
  { encoding: "utf16le" as const, bytes: Buffer.from(FIELD, "utf16le") },
];

/** `undefined` when the file has no value; `null` when the sidebar shows every project. */
export function lastScopeKey(data: Buffer): string | null | undefined {
  let best: { at: number; encoding: BufferEncoding; length: number } | null = null;
  for (const { encoding, bytes } of NEEDLES) {
    const at = data.lastIndexOf(bytes);
    if (at >= 0 && (!best || at > best.at)) best = { at, encoding, length: bytes.length };
  }
  if (!best) return undefined;
  const width = best.encoding === "utf16le" ? 2 : 1;
  const rest = data.subarray(best.at + best.length, best.at + best.length + 600 * width).toString(best.encoding);
  const match = /^\s*(null|"(?:[^"\\]|\\.)*")/.exec(rest);
  if (!match) return undefined;
  return JSON.parse(match[1]!) as string | null;
}

export function readScopeKey(directory: string): string | null | undefined {
  const files = readdirSync(directory)
    .filter((name) => /^\d+\.(log|ldb)$/.test(name))
    // The log holds everything since the last compaction, so it wins; then
    // newer tables before older ones.
    .sort((a, b) => Number(b.endsWith(".log")) - Number(a.endsWith(".log")) || b.localeCompare(a));
  for (const name of files) {
    const value = lastScopeKey(readFileSync(join(directory, name)));
    if (value !== undefined) return value;
  }
  return undefined;
}

interface WatcherEvents {
  change: [string | null];
}

/** Polls the app's localStorage and reports when the sidebar's project filter changes. */
export class SidebarScopeWatcher extends EventEmitter<WatcherEvents> {
  readonly directory: string;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | null = null;
  private stamp = "";
  private value: string | null = null;

  constructor(dataDir: string, log: Logger) {
    super();
    this.directory = join(homedir(), "Library", "Application Support", dataDir, "Local Storage", "leveldb");
    this.log = log;
  }

  get current(): string | null {
    return this.value;
  }

  start(intervalMs = 750): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private poll() {
    try {
      const stamp = readdirSync(this.directory)
        .map((name) => `${name}:${statSync(join(this.directory, name)).mtimeMs}`)
        .join("|");
      if (stamp === this.stamp) return;
      this.stamp = stamp;
      const next = readScopeKey(this.directory);
      // Nothing found (just after a compaction): keep the last known filter.
      if (next === undefined || next === this.value) return;
      this.value = next;
      this.log.info(`sidebar filter: ${next === null ? "all projects" : JSON.stringify(next)}`);
      this.emit("change", next);
    } catch (error) {
      if (this.stamp !== "error") this.log.warn("could not read the T3 Code sidebar filter", error);
      this.stamp = "error";
    }
  }
}
