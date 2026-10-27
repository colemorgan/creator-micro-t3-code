#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Config, defaultConfigPath, loadConfig, saveConfig } from "./config.ts";
import { Controller } from "./controller.ts";
import { CodexMicroDevice, listEndpoints, sleep } from "./device/device.ts";
import { lightingFrame, STATUS_COLORS } from "./device/lighting.ts";
import { RPC_METHODS } from "./device/protocol.ts";
import { createHost } from "./host/host.ts";
import { createLogger } from "./log.ts";
import { T3Environment } from "./t3/environment.ts";

const USAGE = `codex-micro-t3 — drive a Work Louder Codex Micro from T3 Code

Usage:
  codex-micro-t3 run                     Run the bridge in the foreground
  codex-micro-t3 pair <url> <token>      Add a T3 Code server (token from \`t3 auth session issue\`)
  codex-micro-t3 status                  Show servers and what each agent key would show
  codex-micro-t3 doctor [seconds]        Check the device: status, light test, then print input
  codex-micro-t3 install                 Start at login (macOS LaunchAgent)
  codex-micro-t3 uninstall               Remove the LaunchAgent

Config: ${defaultConfigPath()}`;

const LABEL = "dev.t3.codex-micro";

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
  controller.refresh();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log.info("stopping");
    controller.dispose();
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
  controller.refresh();
  console.log(`\nAgent keys (${config.agentSource}):`);
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

function install() {
  if (process.platform !== "darwin") throw new Error("install is for macOS; use a systemd user unit elsewhere");
  const cli = resolve(fileURLToPath(import.meta.url));
  const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  const logFile = join(homedir(), "Library", "Logs", "codex-micro-t3.log");
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(process.execPath)}</string>
    <string>${escape(cli)}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${escape(logFile)}</string>
  <key>StandardErrorPath</key><string>${escape(logFile)}</string>
</dict>
</plist>
`,
  );
  const domain = `gui/${process.getuid!()}`;
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
  } catch {}
  execFileSync("launchctl", ["bootstrap", domain, plist]);
  console.log(`Installed ${plist}\nLogs: ${logFile}`);
  console.log(
    `\nmacOS will ask for two permissions for ${process.execPath}:\n` +
      `  • Input Monitoring (to read the keys)\n  • Accessibility (to press shortcuts in T3 Code)\n` +
      `Grant both in System Settings → Privacy & Security, then run: launchctl kickstart -k ${domain}/${LABEL}`,
  );
}

function uninstall() {
  const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}/${LABEL}`], { stdio: "ignore" });
  } catch {}
  if (existsSync(plist)) rmSync(plist);
  console.log("Removed the LaunchAgent.");
}

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, () => unknown> = {
  run,
  pair: () => pair(args[0], args[1]),
  status,
  doctor: () => doctor(Number(args[0] ?? 20)),
  install,
  uninstall,
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
