import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// macOS grants Input Monitoring and Accessibility per app. Running the bridge
// from a small app bundle (a copy of this Node binary, ad-hoc signed) gives it
// a stable name and identity in Privacy & Security, and the permissions
// survive edits to the bridge's own scripts.

export const LABEL = "dev.t3.codex-micro";
export const APP_NAME = "Codex Micro for T3 Code";
export const APP_DIR = join(homedir(), "Applications", `${APP_NAME}.app`);
export const APP_EXECUTABLE = join(APP_DIR, "Contents", "MacOS", APP_NAME);
export const LOG_FILE = join(homedir(), "Library", "Logs", "codex-micro-t3.log");
const AGENT_PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const domain = () => `gui/${process.getuid!()}`;

/** Creates or refreshes the app bundle; returns true when the binary changed. */
export function buildAppBundle(): boolean {
  const contents = join(APP_DIR, "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  writeFileSync(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${LABEL}</string>
  <key>CFBundleName</key><string>${xml(APP_NAME)}</string>
  <key>CFBundleDisplayName</key><string>${xml(APP_NAME)}</string>
  <key>CFBundleExecutable</key><string>${xml(APP_NAME)}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>Opens threads and presses shortcuts in T3 Code when you use the Codex Micro.</string>
</dict>
</plist>
`,
  );
  // Signing rewrites the copy, so remember which binary it came from instead.
  const source = realpathSync(process.execPath);
  const { size, mtimeMs } = statSync(source);
  const stamp = JSON.stringify({ source, size, mtimeMs });
  const stampFile = join(contents, "Resources", "node-source.json");
  const fresh =
    existsSync(APP_EXECUTABLE) && existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp;
  if (fresh) return false;
  rmSync(APP_EXECUTABLE, { force: true });
  copyFileSync(source, APP_EXECUTABLE);
  // Homebrew's node links a shared libnode through @executable_path/../lib.
  const libDir = join(dirname(source), "..", "lib");
  const libraries = existsSync(libDir)
    ? readdirSync(libDir).filter((name) => /^libnode.*\.dylib$/.test(name))
    : [];
  rmSync(join(contents, "lib"), { recursive: true, force: true });
  if (libraries.length) mkdirSync(join(contents, "lib"), { recursive: true });
  for (const name of libraries) copyFileSync(join(libDir, name), join(contents, "lib", name));
  execFileSync("chmod", ["-R", "u+w", contents]);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--identifier", LABEL, APP_DIR], {
    stdio: "ignore",
  });
  mkdirSync(dirname(stampFile), { recursive: true });
  writeFileSync(stampFile, stamp);
  return true;
}

function writeAgent(path: string, label: string, args: string[], keepAlive: boolean, logFile: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${[APP_EXECUTABLE, ...args].map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>${keepAlive ? "<dict><key>SuccessfulExit</key><false/></dict>" : "<false/>"}
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`,
  );
}

function bootout(label: string) {
  try {
    execFileSync("launchctl", ["bootout", `${domain()}/${label}`], { stdio: "ignore" });
  } catch {}
}

/** Runs the bridge at login, restarting it if it crashes. */
export function installAgent(cliPath: string): void {
  buildAppBundle();
  bootout(LABEL);
  writeAgent(AGENT_PLIST, LABEL, [cliPath, "run"], true, LOG_FILE);
  execFileSync("launchctl", ["bootstrap", domain(), AGENT_PLIST]);
}

export function uninstallAgent(): void {
  bootout(LABEL);
  if (existsSync(AGENT_PLIST)) rmSync(AGENT_PLIST);
}

export function restartAgent(): void {
  execFileSync("launchctl", ["kickstart", "-k", `${domain()}/${LABEL}`]);
}

/**
 * Runs one CLI command inside the GUI session through the app bundle, so it
 * has the bundle's permissions even when invoked over SSH. Returns its output.
 */
export async function runInSession(cliPath: string, args: string[], timeoutMs: number): Promise<string> {
  buildAppBundle();
  const label = `${LABEL}.oneshot`;
  const logFile = join(homedir(), "Library", "Logs", "codex-micro-t3-oneshot.log");
  const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  bootout(label);
  rmSync(logFile, { force: true });
  writeAgent(plist, label, [cliPath, ...args], false, logFile);
  execFileSync("launchctl", ["bootstrap", domain(), plist]);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const listing = execFileSync("launchctl", ["print", `${domain()}/${label}`], { encoding: "utf8" });
      if (/state = (not running|exited)/.test(listing) && /last exit code/.test(listing)) break;
    }
  } finally {
    bootout(label);
    rmSync(plist, { force: true });
  }
  return existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
}
