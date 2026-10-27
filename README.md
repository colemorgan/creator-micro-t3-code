<img src="assets/icon.svg" width="64" height="64" alt="">

# Creator Micro T3 Code Adapter

Use a Work Louder **Codex Micro** or **Creator Micro 2** (on its Codex layer)
with [T3 Code](https://t3.codes), the way the ChatGPT app uses it for Codex.

It's a small background program, not firmware: the keyboard's stock firmware
already reports every key, the knob and the stick, and takes lighting
commands, over its vendor HID channel. The bridge reads that channel and
drives T3 Code through its server API and a few app shortcuts.

## What the keys do

Factory Codex layout, mapped to T3 Code:

| Control | Action |
|---|---|
| Agent keys 1–6 | Six threads (most recently updated, across all your T3 Code servers). Colour shows status: white idle, blue working, green finished and unread, amber needs you, red error. The selected thread breathes. Tap to open it in the background; double-tap to bring T3 Code forward. |
| FAST | Toggle Fast mode on the selected thread (Claude Fast Mode, Codex priority tier) |
| APPR / REJ | Approve or decline the selected thread's pending request (or the only waiting one on the keys) |
| SPLIT | Fork the selected thread and open the fork |
| MIC (wide key) | Push to talk: hold to record; double-tap to keep recording, tap again to stop |
| CODEX | Send the composer |
| Stick | Up: Plan mode on/off · Left/Right: back/forward · Down: sidebar |
| Knob | Navigation mode: turn for ↑/↓, click for Enter (works in pickers). Hold to switch to Reasoning mode (turn to change effort) or Agents mode (turn to step through the agent keys). The ring flashes the mode's colour. |

Lighting follows the factory behaviour: the ring stays dark except while
recording, while the selected thread works, or briefly after the selection
changes, and everything goes dark after three minutes idle.

## Setup (macOS)

Requires Node 24+ and pnpm.

```sh
git clone <this repo> ~/codex-micro-t3 && cd ~/codex-micro-t3
pnpm install

# For each T3 Code server you use (the desktop app's own server is on :3773),
# mint a token that can only read and operate threads:
t3 auth session issue --scope orchestration:read --scope orchestration:operate \
  --label "Codex Micro bridge" --token-only
node src/cli.ts pair http://127.0.0.1:3773 <token>
node src/cli.ts pair http://<remote-host>:3773 <token>   # optional

node src/cli.ts install
```

`install` creates `~/Applications/Codex Micro for T3 Code.app` and a login
agent. In **System Settings → Privacy & Security**, allow it under **Input
Monitoring** and **Accessibility**, then run `node src/cli.ts restart`. Quit
the ChatGPT app: it drives the same lights.

Switch the keyboard to its Codex layer.

## Configuration

`~/.config/codex-micro-t3/config.json` (written by `pair`, owner-only since it
holds tokens). Everything except `environments` is optional:

```jsonc
{
  "environments": [{ "url": "http://127.0.0.1:3773", "token": "…" }],
  "app": { "name": "T3 Code (Beta)", "scheme": "t3code" },
  "agentSource": "recent",           // or "priority" (needs-you first), "pinned"
  "pins": [null, null, null, null, null, null], // "environmentId/threadId" per key
  "knobMode": "navigation",           // or "reasoning", "agents"
  "brightness": 1,
  "autoDimMs": 180000,                // null to never dim
  "mic": { "mode": "hold", "shortcut": "fn" }, // Typeless/Wispr Flow hold Fn;
                                      // "dictation" uses macOS Dictation;
                                      // "shortcut" presses a toggle shortcut
  "sendShortcut": "enter",
  "controls": {                       // remap any command key or stick direction
    "ACT06": "fast", "ACT07": "approve", "ACT08": "decline", "ACT09": "fork",
    "ACT10": "mic", "ACT12": "send",
    "JOY_UP": "togglePlanMode", "JOY_RIGHT": "command:navigation.forward",
    "JOY_DOWN": "command:sidebar.toggle", "JOY_LEFT": "command:navigation.back"
  },
  "logLevel": "info"
}
```

Actions: `fast`, `approve`, `approveForSession`, `decline`, `stop`, `fork`,
`mic`, `send`, `togglePlanMode`, `increaseEffort`, `decreaseEffort`,
`nextSlot`, `previousSlot`, `focusApp`, `none`, `command:<T3 keybinding id>`
(e.g. `command:terminal.toggle`), or `keys:<shortcut>` (e.g. `keys:cmd+shift+e`).

## Commands

```
node src/cli.ts status        servers, and what each agent key shows
node src/cli.ts session doctor   device check, light test, live input (with the app's permissions)
node src/cli.ts session permissions
node src/cli.ts action <name> run one action as if pressed
node src/cli.ts rpc <device.status|sys.version|fs.list|fs.read> [params]   read-only device calls
```

Logs: `~/Library/Logs/codex-micro-t3.log`.

## How it works

- **Device** (`src/device`): node-hid on the vendor collection (usage page
  `0xFF00`, report 6), newline-delimited JSON-RPC: `v.oai.hid`/`v.oai.rad`
  notifications in, `v.oai.thstatus` (agent keys) and `v.oai.rgbcfg` (ring
  and backlight) out. Framing is probed with `device.status`.
- **T3 Code** (`src/t3`): Effect RPC over `/ws?orchestrationProtocol=2` with
  a bearer token; `orchestration.subscribeShell` for thread state and
  `orchestration.dispatchCommand` for approve, interrupt, fork, plan mode and
  model options.
- **App** (`src/host`): `t3code://threads/<env>/<thread>` links open threads;
  CoreGraphics key events press T3 Code shortcuts (only once it's frontmost)
  and hold Fn for dictation apps.

Thread status follows T3 Code's sidebar; lighting follows the Codex app's
factory defaults as documented by
[FreeMicro](https://github.com/eliBenven/freemicro). The HID framing and slot
assignment are adapted from Hormold's in-app integration
([t3code#23869](https://github.com/pingdotgg/t3code/pull/23869), MIT).

## Development

```sh
pnpm test        # node:test, no device or server needed
pnpm typecheck
```
