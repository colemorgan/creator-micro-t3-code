#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type ActionName, type Config, defaultConfigPath, loadConfig, saveConfig } from "./config.ts";
import { Controller } from "./controller.ts";
import { CodexMicroDevice, listEndpoints, sleep } from "./device/device.ts";
import { lightingFrame, STATUS_COLORS } from "./device/lighting.ts";
import { RPC_METHODS } from "./device/protocol.ts";
import { createHost } from "./host/host.ts";
import { SidebarScopeWatcher } from "./host/sidebarScope.ts";
import {
  APP_DIR,
  APP_NAME,
  installAgent,
  LOG_FILE,
  restartAgent,
  runInSession,
  uninstallAgent,
} from "./host/launchAgent.ts";
import { createLogger } from "./log.ts";
import { T3Environment } from "./t3/environment.ts";

const USAGE = `codex-micro-t3 — drive a Work Louder Codex Micro from T3 Code

Usage:
  codex-micro-t3 run                     Run the bridge in the foreground
  codex-micro-t3 pair <url> <token>      Add a T3 Code server (token from \`t3 auth session issue\`)
  codex-micro-t3 status                  Show servers and what each agent key would show
  codex-micro-t3 doctor [seconds]        Check the device: status, light test, then print input
  codex-micro-t3 install                 Start at login (macOS login agent)
  codex-micro-t3 restart                 Restart the login agent
  codex-micro-t3 uninstall               Remove the login agent
  codex-micro-t3 session <command>       Run a command with the agent's macOS permissions
  codex-micro-t3 rpc <method> [params]   Read-only device call (device.status, fs.list, fs.read…)
  codex-micro-t3 action <name>           Run one action as if its key were pressed

Config: ${defaultConfigPath()}`;

const CLI_PATH = resolve(fileURLToPath(import.meta.url));

function environmentsOf(config: Config, log = createLogger(config.logLevel)) {
  return config.environments.map((entry) => new T3Environment({ ...entry, log }));
}

async function run() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  if (config.environments.length === 0) {
    log.error(`No T3 Code server configured. Run: codex-micro-t3 pair <url> <token>`);
    process.exit(1);
  }
  const environments = environmentsOf(config, log);
  const device = new CodexMicroDevice(log);
  const host = createHost({ appName: config.app.name, scheme: config.app.scheme, log });
  const controller = new Controller(config, environments, device, host, log);
  device.on("input", (input) => {
    log.debug("input", input);
    controller.handleInput(input);
  });
  device.on("state", (state) => {
    if (state.connected) {
      log.info(
        `device: ${state.transport ?? "?"}` +
          (state.firmwareVersion ? `, firmware ${state.firmwareVersion}` : "") +
          (state.batteryPercentage !== null ? `, battery ${state.batteryPercentage}%` : ""),
      );
      controller.deviceConnected();
    } else {
      log.info("device: disconnected");
    }
  });
  for (const environment of environments) environment.start();
  device.start();
  let sidebar: SidebarScopeWatcher | null = null;
  if (config.followSidebar && process.platform === "darwin") {
    sidebar = new SidebarScopeWatcher(config.app.dataDir, log);
    sidebar.on("change", (scope) => controller.setScope(scope));
    sidebar.start();
    controller.scope = sidebar.current;
  }
  controller.refresh();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log.info("stopping");
    await controller.releaseHeldKeys();
    controller.dispose();
    sidebar?.stop();
    for (const environment of environments) environment.stop();
    await device.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

async function pair(url: string | undefined, token: string | undefined) {
  if (!url || !token) throw new Error("Usage: codex-micro-t3 pair <url> <token>");
  const origin = new URL(url).origin;
  const config = loadConfig();
  const log = createLogger("warn");
  const environment = new T3Environment({ url: origin, token, log });
  environment.start();
  const deadline = Date.now() + 15_000;
  while (!environment.ready && Date.now() < deadline) await sleep(200);
  const connected = environment.ready;
  environment.stop();
  if (!connected) throw new Error(`Could not connect to ${origin} with that token`);
  const environments = [
    ...config.environments.filter((entry) => new URL(entry.url).origin !== origin),
    { url: origin, token },
  ];
  saveConfig({ ...config, environments });
  console.log(
    `Paired ${environment.config!.label || origin} (environment ${environment.environmentId}, ` +
      `${environment.threads.size} threads). Saved to ${defaultConfigPath()}`,
  );
}

async function status() {
  const config = loadConfig();
  const log = createLogger("warn");
  const environments = environmentsOf(config, log);
  for (const environment of environments) environment.start();
  const deadline = Date.now() + 10_000;
  while (environments.some((e) => !e.ready) && Date.now() < deadline) await sleep(200);
  for (const environment of environments) {
    console.log(
      environment.ready
        ? `● ${environment.options.url}: ${environment.config!.label} (T3 Code ${environment.config!.serverVersion}), ${environment.threads.size} threads`
        : `○ ${environment.options.url}: not connected`,
    );
  }
  const noop = { setLighting: async () => {}, invalidateLighting() {} };
  const host = createHost({ appName: config.app.name, scheme: config.app.scheme, log });
  const controller = new Controller(config, environments, noop, host, log);
  if (config.followSidebar && process.platform === "darwin") {
    const sidebar = new SidebarScopeWatcher(config.app.dataDir, log);
    sidebar.start();
    sidebar.stop();
    controller.scope = sidebar.current;
  }
  controller.refresh();
  const scope = controller.scope === null ? "all projects" : JSON.stringify(controller.scope);
  console.log(
    `\nAgent keys (${config.agentSource}${config.followSidebar ? `, sidebar: ${scope}, settled hidden` : ""}):`,
  );
  for (const slot of controller.slots) {
    const mark = slot.ref && controller.selected?.threadId === slot.ref.threadId ? "▶" : " ";
    console.log(` ${mark} ${slot.index + 1}. ${slot.status.padEnd(11)} ${slot.title ?? "—"}`);
  }
  try {
    const endpoints = await listEndpoints();
    console.log(
      `\nDevice: ${endpoints.length ? endpoints.map((e) => `${e.transport} ${e.path}`).join(", ") : "not found"}`,
    );
  } catch (error) {
    console.log(`\nDevice: ${(error as Error).message}`);
  }
  controller.dispose();
  for (const environment of environments) environment.stop();
  process.exit(0);
}

async function doctor(seconds: number) {
  const log = createLogger("info");
  const endpoints = await listEndpoints();
  console.log(`HID endpoints: ${endpoints.length ? JSON.stringify(endpoints) : "none"}`);
  if (endpoints.length === 0) {
    console.log(
      "No Codex Micro found. Check the cable/Bluetooth, quit the ChatGPT app, and on macOS grant Input Monitoring to the program running this.",
    );
    process.exit(1);
  }
  const device = new CodexMicroDevice(log);
  device.on("input", (input) => console.log("input", JSON.stringify(input)));
  device.start();
  const deadline = Date.now() + 10_000;
  while (!device.current.connected && Date.now() < deadline) await sleep(100);
  if (!device.current.connected) {
    console.log("Could not open the device (see warnings above).");
    await device.stop();
    process.exit(1);
  }
  console.log("device.status:", JSON.stringify(await device.call(RPC_METHODS.status, null)));
  console.log("Light test: each status colour on every agent key…");
  for (const status of Object.keys(STATUS_COLORS) as (keyof typeof STATUS_COLORS)[]) {
    await device.setLighting(
      lightingFrame({
        slots: Array.from({ length: 6 }, (_, i) => ({ status, selected: i === 0 })),
        brightness: 1,
        voice: "idle",
        selectionFlash: true,
        flash: null,
      }),
    );
    console.log(`  ${status}`);
    await sleep(700);
  }
  console.log(`Press keys, turn the knob, move the stick (${seconds}s)…`);
  await sleep(seconds * 1_000);
  await device.stop();
  process.exit(0);
}

/** Runs one bridge action as if its key were pressed (for testing and scripting). */
async function action(name: string | undefined) {
  if (!name) throw new Error("Usage: codex-micro-t3 action <name>, e.g. command:sidebar.toggle");
  const config = loadConfig();
  const log = createLogger("debug");
  const environments = environmentsOf(config, log);
  for (const environment of environments) environment.start();
  const deadline = Date.now() + 10_000;
  while (environments.some((e) => !e.ready) && Date.now() < deadline) await sleep(100);
  const noop = { setLighting: async () => {}, invalidateLighting() {} };
  const host = createHost({ appName: config.app.name, scheme: config.app.scheme, log });
  const controller = new Controller({ ...config, autoDimMs: null }, environments, noop, host, log);
  controller.refresh();
  controller.runAction(name as ActionName);
  await sleep(2_500);
  controller.dispose();
  for (const environment of environments) environment.stop();
  process.exit(0);
}

/** Releases every modifier the bridge can hold, in case one is stuck down. */
async function releaseKeys() {
  const { execFileSync } = await import("node:child_process");
  const { holdKeyScript, parseShortcut } = await import("./host/shortcut.ts");
  for (const key of ["fn", "command", "shift", "option", "control"]) {
    execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", holdKeyScript(parseShortcut(key)!, false)]);
  }
  console.log("Released Fn, Command, Shift, Option and Control.");
  process.exit(0);
}

/** Reports the macOS permissions the bridge needs, as seen by this process. */
async function permissions() {
  const { execFileSync } = await import("node:child_process");
  const check = (script: string) => {
    try {
      return execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
        encoding: "utf8",
      }).trim();
    } catch (error) {
      return `error: ${(error as Error).message.split("\n").at(-2) ?? error}`;
    }
  };
  console.log(`Accessibility (osascript child): ${check('ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()')}`);
  console.log(
    `Input Monitoring: ${check('ObjC.import("IOKit"); ObjC.bindFunction("IOHIDCheckAccess", ["int", ["int"]]); ["granted", "denied", "unknown"][$.IOHIDCheckAccess(1)]')}`,
  );
  console.log(
    `Post events: ${check('ObjC.import("IOKit"); ObjC.bindFunction("IOHIDCheckAccess", ["int", ["int"]]); ["granted", "denied", "unknown"][$.IOHIDCheckAccess(0)]')}`,
  );
  process.exit(0);
}

// Only calls that can't change the device: no fs.write, no bootloader.
const READ_ONLY_RPC = new Set(["device.status", "sys.version", "fs.list", "fs.read"]);

/** Sends one read-only JSON-RPC call to the device and prints the result. */
async function rpc(method: string | undefined, params: string | undefined) {
  if (!method || !READ_ONLY_RPC.has(method)) {
    throw new Error(`Usage: codex-micro-t3 rpc <${[...READ_ONLY_RPC].join("|")}> [json params]`);
  }
  const device = new CodexMicroDevice(createLogger("warn"));
  device.start();
  const deadline = Date.now() + 10_000;
  while (!device.current.connected && Date.now() < deadline) await sleep(100);
  try {
    if (!device.current.connected) throw new Error("Device not connected");
    const result = await device.call(method, params === undefined ? null : JSON.parse(params));
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } finally {
    await device.stop({ blank: false });
  }
  process.exit(0);
}

function install() {
  if (process.platform !== "darwin") {
    throw new Error("install is for macOS; on Linux run `codex-micro-t3 run` from a systemd user unit");
  }
  installAgent(CLI_PATH);
  console.log(`Installed "${APP_NAME}" (${APP_DIR}) as a login agent.\nLogs: ${LOG_FILE}`);
  console.log(
    `\nIn System Settings → Privacy & Security, allow "${APP_NAME}" under:\n` +
      `  • Input Monitoring (to read the keys)\n  • Accessibility (to press shortcuts in T3 Code)\n` +
      `Then run: codex-micro-t3 restart`,
  );
}

function uninstall() {
  uninstallAgent();
  console.log("Removed the login agent.");
}

/** Runs a command as the app bundle in the GUI session (for permissions over SSH). */
async function session(rest: string[]) {
  if (rest.length === 0) throw new Error("Usage: codex-micro-t3 session <command> [args]");
  process.stdout.write(await runInSession(CLI_PATH, rest, 120_000));
}

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, () => unknown> = {
  run,
  pair: () => pair(args[0], args[1]),
  status,
  doctor: () => doctor(Number(args[0] ?? 20)),
  install,
  uninstall,
  restart: () => restartAgent(),
  session: () => session(args),
  rpc: () => rpc(args[0], args[1]),
  action: () => action(args[0]),
  permissions,
  "release-keys": releaseKeys,
};
const handler = command ? commands[command] : undefined;
if (!handler) {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}
Promise.resolve(handler()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
