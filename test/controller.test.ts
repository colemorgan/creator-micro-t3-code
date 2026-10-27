import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { Controller } from "../src/controller.ts";
import { silentLogger } from "../src/log.ts";
import type { ThreadShell } from "../src/t3/types.ts";
import { FakeEnvironment, FakeHost, FakeLights, thread } from "./fixtures.ts";

const CLAUDE = {
  instanceId: "claudeAgent",
  models: [
    {
      slug: "claude-opus-5-5",
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "low" }, { id: "medium", isDefault: true }, { id: "high" }],
          },
          { id: "fastMode", label: "Fast Mode", type: "boolean" },
        ],
      },
    },
  ],
};
const CODEX = {
  instanceId: "codex",
  models: [
    {
      slug: "gpt-6.1-sol",
      capabilities: {
        optionDescriptors: [
          {
            id: "serviceTier",
            type: "select",
            options: [{ id: "default", label: "Standard", isDefault: true }, { id: "priority", label: "Fast" }],
          },
        ],
      },
    },
  ],
};
const KEYBINDINGS = [
  { command: "composer.effort", shortcut: { key: "e", metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, modKey: true } },
  { command: "sidebar.toggle", shortcut: { key: "b", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: true } },
];

let host: FakeHost;
let lights: FakeLights;

function setup(threads: ThreadShell[], config: Partial<Config> = {}) {
  host = new FakeHost();
  lights = new FakeLights();
  const environment = new FakeEnvironment("env", threads, {
    providers: [CLAUDE, CODEX],
    keybindings: KEYBINDINGS,
  });
  const controller = new Controller(
    { ...DEFAULT_CONFIG, ...config },
    [environment as any],
    lights,
    host as any,
    silentLogger,
  );
  controller.refresh();
  return { controller, environment };
}

const press = (controller: Controller, key: string) => {
  controller.handleInput({ type: "key", key, act: 1 });
  controller.handleInput({ type: "key", key, act: 0 });
};

beforeEach(() => {
  mock.timers.reset();
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-10-27T12:00:00Z") });
});

test("a tap opens the key's thread in the background; a double tap brings the app forward", () => {
  const { controller } = setup([thread({ id: "a" }), thread({ id: "b", updatedAt: "2026-10-27T09:00:00Z" })]);
  press(controller, "AG01");
  assert.deepEqual(host.calls, ["open b"]);
  assert.equal(controller.selected?.threadId, "b");
  mock.timers.tick(100);
  press(controller, "AG01");
  assert.deepEqual(host.calls, ["open b", "open b foreground"]);
  mock.timers.tick(1_000);
  press(controller, "AG01");
  assert.equal(host.calls.at(-1), "open b");
  press(controller, "AG05");
  assert.equal(host.calls.length, 3, "an empty key does nothing");
});

test("follows the thread you open in the app", () => {
  const { controller, environment } = setup([
    thread({ id: "a", lastVisitedAt: "2026-10-27T11:00:00Z" }),
    thread({ id: "b", lastVisitedAt: "2026-10-27T11:30:00Z" }),
  ]);
  assert.equal(controller.selected?.threadId, "b");
  environment.threads.set("a", thread({ id: "a", lastVisitedAt: "2026-10-27T12:00:01Z" }));
  controller.refresh();
  assert.equal(controller.selected?.threadId, "a");
});

test("approve answers the selected thread, else the only key thread waiting", async () => {
  const waiting = thread({ id: "w", pendingRuntimeRequest: { id: "req-1", kind: "command_execution" } });
  const { controller, environment } = setup([thread({ id: "x" }), waiting]);
  press(controller, "ACT07");
  await Promise.resolve();
  assert.deepEqual(environment.dispatched, [
    { type: "runtime-request.respond", threadId: "w", requestId: "req-1", decision: "accept" },
  ]);
  press(controller, "ACT08");
  await Promise.resolve();
  assert.equal(environment.dispatched[1]?.decision, "decline");
});

test("approve refuses to guess between several waiting threads", async () => {
  const { controller, environment } = setup([
    thread({ id: "a", pendingRuntimeRequest: { id: "1", kind: "command_execution" } }),
    thread({ id: "b", pendingRuntimeRequest: { id: "2", kind: "file_change" } }),
  ]);
  press(controller, "ACT07");
  await Promise.resolve();
  assert.equal(environment.dispatched.length, 0);
  const flash = lights.frames.length;
  mock.timers.tick(200);
  assert.ok(lights.frames.length > flash, "shows the unavailable flash");
  press(controller, "AG01");
  press(controller, "ACT07");
  await Promise.resolve();
  assert.equal(environment.dispatched[0]?.requestId, "2");
});

test("fast toggles Claude's fastMode and Codex's priority tier on the selected thread", async () => {
  const { controller, environment } = setup([
    thread({ id: "claude" }),
    thread({
      id: "codex",
      updatedAt: "2026-10-27T09:00:00Z",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol", options: [] },
    }),
  ]);
  press(controller, "AG00");
  press(controller, "ACT06");
  await Promise.resolve();
  assert.deepEqual(environment.dispatched[0], {
    type: "thread.model-selection.set",
    threadId: "claude",
    modelSelection: {
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "fastMode", value: true }],
    },
  });
  mock.timers.tick(1_000);
  press(controller, "AG01");
  press(controller, "ACT06");
  await Promise.resolve();
  assert.deepEqual((environment.dispatched[1]?.modelSelection as any).options, [
    { id: "serviceTier", value: "priority" },
  ]);
  // The composer's own copy: open the effort menu, go to the end, step to the item.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(host.calls.filter((call) => call.startsWith("press")), [
    "press cmd+shift+e end arrowup enter", // Claude: On, [Off]
    "press cmd+shift+e end enter", // Codex: Standard, [Fast]
  ]);
  press(controller, "AG00");
  press(controller, "ACT06");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.calls.at(-1), "press cmd+shift+e end enter", "second press turns Claude's back off");
});

test("the knob in reasoning mode steps effort; clockwise lowers it", async () => {
  const { controller, environment } = setup(
    [thread({ id: "a", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "medium" }] } })],
    { knobMode: "reasoning" },
  );
  press(controller, "AG00");
  controller.handleInput({ type: "key", key: "ENC_CC", act: 2 });
  await Promise.resolve();
  assert.deepEqual((environment.dispatched[0]?.modelSelection as any).options, [{ id: "effort", value: "high" }]);
  controller.handleInput({ type: "key", key: "ENC_CW", act: 2 });
  await Promise.resolve();
  assert.deepEqual((environment.dispatched[1]?.modelSelection as any).options, [{ id: "effort", value: "low" }]);
});

test("holding the knob cycles its mode; a click runs the mode's action", () => {
  const { controller } = setup([thread({ id: "a" })]);
  assert.equal(controller.knobMode, "navigation");
  controller.handleInput({ type: "key", key: "ENC_CLK", act: 1 });
  mock.timers.tick(600);
  controller.handleInput({ type: "key", key: "ENC_CLK", act: 0 });
  assert.equal(controller.knobMode, "reasoning");
  assert.equal(host.calls.length, 0, "a hold swallows the release");
  controller.handleInput({ type: "key", key: "ENC_CLK", act: 1 });
  mock.timers.tick(600);
  controller.handleInput({ type: "key", key: "ENC_CLK", act: 0 });
  assert.equal(controller.knobMode, "agents");
  controller.handleInput({ type: "key", key: "ENC_CW", act: 2 });
  assert.deepEqual(host.calls, ["open a"]);
});

test("navigation knob presses arrows and Enter in the app", async () => {
  const { controller } = setup([thread({ id: "a" })]);
  controller.handleInput({ type: "key", key: "ENC_CW", act: 2 });
  controller.handleInput({ type: "key", key: "ENC_CC", act: 2 });
  controller.handleInput({ type: "key", key: "ENC_CLK", act: 1 });
  controller.handleInput({ type: "key", key: "ENC_CLK", act: 0 });
  await Promise.resolve();
  assert.deepEqual(host.calls, ["press arrowup", "press arrowdown", "press enter"]);
});

test("the joystick fires once per push and maps to the factory commands", async () => {
  const { controller, environment } = setup([thread({ id: "a" })]);
  press(controller, "AG00");
  const stick = (angle: number, distance: number) =>
    controller.handleInput({ type: "joystick", angle, distance });
  stick(0.25, 0.3);
  stick(0.25, 0.9);
  stick(0.25, 1);
  stick(0, 0);
  await Promise.resolve();
  assert.deepEqual(host.calls.slice(1), ["press cmd+b"]);
  stick(0.75, 0.8);
  await Promise.resolve();
  assert.deepEqual(environment.dispatched.at(-1), {
    type: "thread.interaction-mode.set",
    threadId: "a",
    interactionMode: "plan",
  });
});

test("mic: hold to talk, or double-tap to latch and tap to stop", () => {
  const { controller } = setup([thread({ id: "a" })]);
  controller.handleInput({ type: "key", key: "ACT10", act: 1 });
  controller.handleInput({ type: "key", key: "ACT11", act: 1 });
  mock.timers.tick(800);
  controller.handleInput({ type: "key", key: "ACT10", act: 0 });
  assert.deepEqual(host.calls, ["dictation start", "dictation stop"]);

  host.calls.length = 0;
  mock.timers.tick(1_000);
  controller.handleInput({ type: "key", key: "ACT10", act: 1 });
  mock.timers.tick(100);
  controller.handleInput({ type: "key", key: "ACT10", act: 0 });
  mock.timers.tick(100);
  controller.handleInput({ type: "key", key: "ACT10", act: 1 });
  controller.handleInput({ type: "key", key: "ACT10", act: 0 });
  mock.timers.tick(5_000);
  assert.deepEqual(host.calls, ["dictation start"], "latched");
  controller.handleInput({ type: "key", key: "ACT10", act: 1 });
  assert.deepEqual(host.calls, ["dictation start", "dictation stop"]);
});

test("mic hold mode holds the configured key while recording", () => {
  const { controller } = setup([thread({ id: "a" })], { mic: { mode: "hold", shortcut: "fn" } });
  controller.handleInput({ type: "key", key: "ACT10", act: 1 });
  mock.timers.tick(1_200);
  controller.handleInput({ type: "key", key: "ACT10", act: 0 });
  assert.deepEqual(host.calls, ["hold fn", "release fn"]);
});

test("send, stop and fork", async () => {
  const running = thread({ id: "r", status: "running", activeRunId: "run-9" });
  const { controller, environment } = setup([running]);
  press(controller, "ACT12");
  await Promise.resolve();
  assert.deepEqual(host.calls, ["press enter"]);

  controller.runAction("stop");
  await Promise.resolve();
  assert.deepEqual(environment.dispatched[0], {
    type: "run.interrupt",
    threadId: "r",
    runId: "run-9",
    holdQueue: true,
  });

  press(controller, "AG00");
  press(controller, "ACT09");
  await Promise.resolve();
  await Promise.resolve();
  const fork = environment.dispatched[1]!;
  assert.equal(fork.type, "thread.fork");
  assert.equal(fork.sourceThreadId, "r");
  assert.deepEqual(fork.sourcePoint, { type: "run", runId: "run-1" });
  assert.equal(host.calls.at(-1), `open ${fork.targetThreadId} foreground`);
});

test("auto-dim turns everything off and input brings it back", () => {
  const { controller } = setup([thread({ id: "a" })], { autoDimMs: 5_000 });
  mock.timers.tick(200);
  const before = lights.frames.length;
  mock.timers.tick(5_000);
  const dark = lights.frames.at(-1) as any;
  assert.ok(lights.frames.length > before);
  assert.ok(dark.slots.every((slot: any) => slot.b === 0));
  controller.handleInput({ type: "joystick", angle: 0, distance: 0.05 });
  assert.equal(lights.frames.at(-1), dark, "a resting stick doesn't wake it");
  controller.handleInput({ type: "joystick", angle: 0, distance: 0.2 });
  assert.ok((lights.frames.at(-1) as any).slots[0].b > 0);
  controller.dispose();
});
