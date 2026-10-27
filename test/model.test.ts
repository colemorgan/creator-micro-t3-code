import assert from "node:assert/strict";
import { test } from "node:test";

import { EFFECT, lightingFrame, STATUS_COLORS, ZONE_OFF } from "../src/device/lighting.ts";
import { fromT3Shortcut, parseShortcut, pressScript } from "../src/host/shortcut.ts";
import { assignSlots, candidateThreads, EMPTY_SLOTS, threadStatus } from "../src/model/slots.ts";
import { thread } from "./fixtures.ts";

test("thread status follows the sidebar, folded into Codex colours", () => {
  assert.equal(threadStatus(thread({ status: "running", activeRunId: "r" })), "working");
  assert.equal(threadStatus(thread({ status: "queued" })), "working");
  assert.equal(threadStatus(thread({ status: "failed" })), "error");
  assert.equal(
    threadStatus(thread({ status: "running", pendingRuntimeRequest: { id: "q", kind: "command_execution" } })),
    "needs-input",
  );
  assert.equal(
    threadStatus(thread({ status: "completed", pendingRuntimeRequest: { id: "q", kind: "user_input" } })),
    "needs-input",
  );
  // An async question the run keeps working past is not "needs you" yet.
  assert.equal(
    threadStatus(
      thread({ status: "running", pendingRuntimeRequest: { id: "q", kind: "user_input", blocking: false } }),
    ),
    "working",
  );
  assert.equal(threadStatus(thread({ pendingGuestMessageCount: 1 })), "needs-input");
  assert.equal(
    threadStatus(
      thread({ latestRunCompletedAt: "2026-10-27T10:00:00Z", lastVisitedAt: "2026-10-27T09:00:00Z" }),
    ),
    "done",
  );
  assert.equal(
    threadStatus(
      thread({ latestRunCompletedAt: "2026-10-27T10:00:00Z", lastVisitedAt: "2026-10-27T11:00:00Z" }),
    ),
    "idle",
  );
  assert.equal(threadStatus(thread({ latestRunId: null, activeProviderThreadId: null })), "idle");
});

test("subagents stay off the keys but light their parent", () => {
  const parent = thread({ id: "parent" });
  const child = thread({
    id: "child",
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
    pendingRuntimeRequest: { id: "q", kind: "command_execution" },
  });
  const archived = thread({ id: "gone", archivedAt: "2026-10-01T00:00:00Z" });
  const snoozed = thread({ id: "later", snoozedUntil: "2099-01-01T00:00:00Z" });
  const candidates = candidateThreads(
    [{ environmentId: "env", threads: [parent, child, archived, snoozed] }],
    "2026-10-27T12:00:00Z",
  );
  assert.deepEqual(
    candidates.map((entry) => [entry.threadId, entry.childNeedsInput]),
    [["parent", true]],
  );
  const [slot] = assignSlots({ threads: candidates, previous: EMPTY_SLOTS, source: "recent", pins: [] });
  assert.equal(slot!.status, "needs-input");
});

test("recent fills keys by update time and keeps threads on their key", () => {
  const at = (minute: number) => `2026-10-27T10:${String(minute).padStart(2, "0")}:00Z`;
  const threads = (ids: string[]) =>
    candidateThreads(
      [{ environmentId: "e", threads: ids.map((id, i) => thread({ id, updatedAt: at(50 - i) })) }],
      at(59),
    );
  const first = assignSlots({
    threads: threads(["a", "b", "c", "d", "e", "f", "g"]),
    previous: EMPTY_SLOTS,
    source: "recent",
    pins: [],
  });
  assert.deepEqual(first.map((slot) => slot.ref?.threadId), ["a", "b", "c", "d", "e", "f"]);
  // "g" jumps to the top; "f" drops out and "g" takes its key, the rest stay put.
  const second = assignSlots({
    threads: threads(["g", "a", "b", "c", "d", "e", "f"]),
    previous: first,
    source: "recent",
    pins: [],
  });
  assert.deepEqual(second.map((slot) => slot.ref?.threadId), ["a", "b", "c", "d", "e", "g"]);
  const pinned = assignSlots({
    threads: threads(["a", "b"]),
    previous: EMPTY_SLOTS,
    source: "recent",
    pins: [null, null, "e/b"],
  });
  assert.deepEqual(pinned.map((slot) => slot.ref?.threadId ?? null), ["a", null, "b", null, null, null]);
});

test("priority puts threads that need you first", () => {
  const threads = candidateThreads(
    [
      {
        environmentId: "e",
        threads: [
          thread({ id: "idle", updatedAt: "2026-10-27T10:59:00Z" }),
          thread({ id: "busy", status: "running", updatedAt: "2026-10-27T10:00:00Z" }),
          thread({ id: "ask", pendingRuntimeRequest: { id: "q", kind: "file_change" }, updatedAt: "2026-10-27T09:00:00Z" }),
          thread({ id: "settled", settledAt: "2026-10-27T08:00:00Z" }),
        ],
      },
    ],
    "2026-10-27T12:00:00Z",
  );
  const slots = assignSlots({ threads, previous: EMPTY_SLOTS, source: "priority", pins: [] });
  assert.deepEqual(slots.map((slot) => slot.ref?.threadId ?? null), ["ask", "busy", "idle", null, null, null]);
});

test("lighting matches the factory: solid colours, selected key breathes, dark backlight", () => {
  const frame = lightingFrame({
    slots: [
      { status: "idle", selected: false },
      { status: "done", selected: true },
      { status: "off", selected: false },
    ],
    brightness: 0.5,
    voice: "idle",
    selectionFlash: false,
    flash: null,
  });
  assert.deepEqual(frame.slots[0], { id: 0, c: STATUS_COLORS.idle, b: 0.5, e: EFFECT.solid, s: 0, sk: 0, sa: 0 });
  assert.deepEqual(frame.slots[1], { id: 1, c: STATUS_COLORS.done, b: 0.5, e: EFFECT.breath, s: 0.4, sk: 0, sa: 0 });
  assert.deepEqual(frame.slots[2], { id: 2, c: 0, b: 0, e: 0, s: 0, sk: 0, sa: 0 });
  assert.equal(frame.slots.length, 6);
  assert.deepEqual(frame.zones, { keys: ZONE_OFF, ambient: ZONE_OFF });
});

test("the ring shows voice, then a working selection, then the selection flash", () => {
  const model = {
    slots: [{ status: "working" as const, selected: true }],
    brightness: 1,
    voice: "idle" as const,
    selectionFlash: false,
    flash: null,
  };
  assert.equal(lightingFrame(model).zones.ambient.e, EFFECT.snake);
  assert.equal(lightingFrame(model).zones.ambient.c, STATUS_COLORS.working);
  assert.equal(lightingFrame({ ...model, voice: "recording" }).zones.ambient.c, 0x2e8b57);
  const flashed = lightingFrame({ ...model, slots: [{ status: "idle", selected: true }], selectionFlash: true });
  assert.equal(flashed.zones.ambient.e, EFFECT.solid);
  assert.equal(flashed.zones.keys.c, STATUS_COLORS.idle);
});

test("shortcuts parse and become System Events statements", () => {
  assert.deepEqual(parseShortcut("cmd+shift+e", true), {
    key: "e",
    command: true,
    control: false,
    shift: true,
    option: false,
  });
  assert.equal(parseShortcut("mod+enter", false)?.control, true);
  assert.equal(parseShortcut("ctrl++", true)?.key, "+");
  assert.equal(parseShortcut("hyper+x", true), null);
  const enter = pressScript([parseShortcut("enter")!], "/Applications/T3 Code (Beta).app");
  assert.match(enter, /bundleWithPath\("\/Applications\/T3 Code \(Beta\)\.app"\)/);
  assert.match(enter, /CGEventCreateKeyboardEvent\(source, 36, true\)[\s\S]*CGEventCreateKeyboardEvent\(source, 36, false\)/);
  assert.match(pressScript([parseShortcut("cmd+shift+[", true)!], "/x.app"), /source, 33, true\); \$\.CGEventSetFlags\(event, 1179648\)/);
  const stroke = fromT3Shortcut(
    { key: "b", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: true },
    true,
  );
  assert.match(pressScript([stroke], "/x.app"), /source, 11, true\); \$\.CGEventSetFlags\(event, 1048576\)/);
  assert.throws(() => pressScript([parseShortcut("cmd+ü", true)!], "/x.app"), /Unsupported key/);
});

test("hold scripts post Fn as a flags change with the Fn flag while held", async () => {
  const { holdKeyScript } = await import("../src/host/shortcut.ts");
  const fn = parseShortcut("fn", true)!;
  assert.match(holdKeyScript(fn, true), /CGEventCreateKeyboardEvent\(source, 63, true\)[\s\S]*CGEventSetFlags\(event, 8388608\)/);
  assert.match(holdKeyScript(fn, false), /CGEventSetFlags\(event, 0\)/);
  assert.match(holdKeyScript(parseShortcut("ctrl+space", true)!, true), /source, 49, true\)[\s\S]*262144/);
});
