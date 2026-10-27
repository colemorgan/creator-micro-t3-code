# Configuration

The bridge reads `~/.config/codex-micro-t3/config.json`. `pair` creates the
file and saves it so only your user can read it, because it holds bearer
tokens. If you create or edit it yourself, keep it private
(`chmod 600`).

For one-off CLI runs, the `CODEX_MICRO_T3_CONFIG` environment variable points
at a different file. The login agent doesn't inherit your shell's
environment, so it always reads the default path.

Every field except `environments` is optional. A missing or invalid value
falls back to its default on its own, without affecting the other fields.
Two exceptions: a file that isn't valid JSON stops the bridge from starting,
and an action name in `controls` isn't checked, so a typo such as `"fasst"`
leaves that key doing nothing.
The bridge reads the file once at startup, so restart it after editing
(`node src/cli.ts restart` on macOS).

## Full example (defaults shown)

```jsonc
{
  "environments": [
    { "url": "http://127.0.0.1:3773", "token": "…" }
  ],
  "app": { "name": "T3 Code (Beta)", "scheme": "t3code", "dataDir": "t3code-v2" },
  "agentSource": "recent",
  "followSidebar": true,
  "pins": [null, null, null, null, null, null],
  "knobMode": "navigation",
  "controls": {
    "ACT06": "fast",
    "ACT07": "approve",
    "ACT08": "decline",
    "ACT09": "fork",
    "ACT10": "mic",
    "ACT12": "send",
    "JOY_UP": "togglePlanMode",
    "JOY_RIGHT": "command:navigation.forward",
    "JOY_DOWN": "command:sidebar.toggle",
    "JOY_LEFT": "command:navigation.back"
  },
  "brightness": 1,
  "autoDimMs": 180000,
  "mic": { "mode": "dictation", "shortcut": "" },
  "sendShortcut": "enter",
  "logLevel": "info"
}
```

## Fields

### `environments`

The T3 Code servers to show threads from, each a `{ url, token }` pair. Add
them with `node src/cli.ts pair <url> <token>`, which checks that the token
works before saving it.

- **`url`**: the server's origin. The desktop app runs its own server at
  `http://127.0.0.1:3773`. A remote server is usually
  `http://<tailscale-ip>:3773` or its HTTPS address.
- **`token`**: a bearer token from `t3 auth session issue`. It needs only
  `orchestration:read` and `orchestration:operate`. Don't use a token with
  wider scopes.

Threads from every server share the six keys.

### `app`

The desktop app the bridge controls.

| Field | Default | Meaning |
|---|---|---|
| `name` | `T3 Code (Beta)` | The app's name, used to bring it forward and to find its bundle. Use `T3 Code (Nightly)` or `T3 Code` for other builds. |
| `scheme` | `t3code` | The URL scheme for opening threads (`t3code://threads/<environment>/<thread>`). |
| `dataDir` | `t3code-v2` | The app's folder in `~/Library/Application Support`, where its sidebar filter is stored. |

### `agentSource`

How threads are ordered onto the six agent keys, after the sidebar filter:

| Value | Keys go to |
|---|---|
| `recent` (default) | The most recently updated threads, as in the Codex app. |
| `priority` | Threads that need you first, then errors, working, finished-unread, and idle. Settled threads only appear while working, waiting on you, or pinned. |
| `pinned` | Your pinned threads, in the sidebar's pinned order. |

A thread keeps its key while it stays in the top six, so lights don't jump
around.

### `followSidebar`

`true` by default. The keys mirror the T3 Code sidebar:

- When the sidebar is filtered to a project, only that project's threads get
  keys. A project open on several servers counts as one, as in the sidebar.
- Settled threads are left off unless they're working or need you.

Set it to `false` to show every project and include settled threads.
Following the filter is macOS-only, because it reads the app's local storage.

### `pins`

Six entries, one per agent key: `null`, or `"<environmentId>/<threadId>"` to
fix a thread to that key. The other keys fill from `agentSource` as usual.
Pins apply after the sidebar filter: with `followSidebar` on, a pinned thread
outside the filtered project, or a settled idle one, isn't shown, and its key
goes to the next thread in line. Set `followSidebar` to `false` to always
show pinned threads.
`node src/cli.ts status` shows each server's environment id.

### `knobMode`

What turning the knob does when the bridge starts. Hold the knob for half a
second to switch modes; the ring flashes the new mode's colour.

| Mode | Ring | Turn | Click |
|---|---|---|---|
| `navigation` | white | ↑ (clockwise) / ↓ | Enter |
| `reasoning` | purple | lower (clockwise) / raise the selected thread's effort | open the effort picker |
| `agents` | blue | next / previous agent key | bring T3 Code forward |

### `controls`

The action for each command key and joystick direction. These are the
physical positions:

| Id | Codex keycap | Default |
|---|---|---|
| `ACT06` | FAST | `fast` |
| `ACT07` | APPR | `approve` |
| `ACT08` | REJ | `decline` |
| `ACT09` | SPLIT | `fork` |
| `ACT10` | MIC (wide; covers `ACT11` too) | `mic` |
| `ACT12` | CODEX | `send` |
| `JOY_UP` / `JOY_RIGHT` / `JOY_DOWN` / `JOY_LEFT` | — | see example |

The keycaps are physically swappable, so map by position rather than by
legend. When `ACT10` is `mic`, it does push-to-talk: hold to record, or
double-tap to latch and tap again to stop. Each joystick direction fires once
per push, past half deflection.

### `brightness`, `autoDimMs`

- **`brightness`**: 0 to 1, applied to every light.
- **`autoDimMs`**: turns the lights off after this many milliseconds without
  key presses or status changes. Use `null` to never dim. Any key press, a
  push of the stick, or a status change wakes them.

### `mic`

How the MIC key records:

| `mode` | Behaviour |
|---|---|
| `dictation` | Starts and stops macOS Dictation from T3 Code's Edit menu. |
| `hold` | Holds `shortcut` down while recording. Use `"fn"` for Typeless or Wispr Flow, which dictate while Fn is held. |
| `shortcut` | Presses `shortcut` to start and again to stop, for apps with a toggle shortcut. |

### `sendShortcut`

The shortcut the CODEX key (`send`) presses. The default `enter` matches T3
Code's default send setting. Use `cmd+enter` if you've changed it in
**Settings → Chat → Send shortcut**.

### `logLevel`

`debug`, `info` (default), `warn` or `error`. At `debug`, every key, knob
turn and command is logged.

## Actions

| Action | Does |
|---|---|
| `nextAttention` | Opens the next thread that needs a look: needs you, then errors, then finished and unread, then working. It covers every thread in the sidebar's filter, not only the six on keys, and wraps at the end. |
| `fast` | Toggles Fast mode on the selected thread: Claude's Fast Mode, or Codex's priority tier. It changes both the server and the composer. |
| `approve` / `approveForSession` / `decline` | Answers the pending request on the selected thread. If the selected thread has none, it answers the only waiting thread on the keys. With several waiting, it never guesses. |
| `stop` | Interrupts the selected thread's run. If the selected thread isn't running, it stops the only running thread on the keys. |
| `fork` | Forks the selected thread at its latest run and opens the fork. |
| `mic` | Push-to-talk, as configured in `mic`. |
| `send` | Presses `sendShortcut` in T3 Code. |
| `togglePlanMode` | Switches the selected thread between Plan and default mode. |
| `increaseEffort` / `decreaseEffort` | Steps the selected thread's reasoning effort. |
| `nextSlot` / `previousSlot` | Opens the next or previous agent key's thread. |
| `focusApp` | Brings T3 Code forward. |
| `command:<id>` | Presses your T3 Code shortcut for that command. The ids are listed in **Settings → Keybindings**, e.g. `command:terminal.toggle`, `command:diff.toggle`, `command:chat.new`, `command:composer.mode`. |
| `keys:<shortcut>` | Presses a literal shortcut in T3 Code, e.g. `keys:cmd+shift+e`. |
| `none` | Does nothing. |

When an action can't run (nothing to approve, no thread selected), the ring
flashes red.

## Shortcut syntax

Shortcuts look like `cmd+shift+e`: modifiers joined by `+`, with the key last.

- **Modifiers:** `cmd` (or `command`, `meta`), `ctrl` (or `control`), `shift`,
  `alt` (or `option`, `opt`), and `mod`, which is Command on macOS and Ctrl
  elsewhere.
- **Keys:** letters, digits and US-layout punctuation; `enter`, `tab`,
  `space`, `escape`, `backspace`, `delete`, `home`, `end`, `pageup`,
  `pagedown`, `arrowup`/`arrowdown`/`arrowleft`/`arrowright`, and `f1`–`f12`.
  `hold` mode also takes `fn` and the modifier keys on their own.

On macOS, the bridge only presses shortcuts once T3 Code is the frontmost
app, so it never types them into another app. Push-to-talk in `hold` mode is
the exception: it holds its key system-wide while recording, because
dictation apps listen globally. On Linux, shortcuts go to whichever window is
active.

## Commands

| Command | What it does |
|---|---|
| `run` | Runs the bridge in the foreground. |
| `pair <url> <token>` | Adds a T3 Code server. |
| `status` | Shows the servers, the sidebar filter, and what each key shows. |
| `install` / `restart` / `uninstall` | Manages the macOS login agent. |
| `session <command>` | Runs a command with the login agent's macOS permissions, e.g. `session doctor`. |
| `doctor [seconds]` | Checks the device, runs a light test, then prints input. |
| `permissions` | Reports Accessibility and Input Monitoring status. |
| `action <name>` | Runs one action as if its key were pressed. |
| `rpc <method> [params]` | Makes a read-only device call: `device.status`, `sys.version`, `fs.list`, or `fs.read` with `{"file":"keymap.json"}`. |
| `release-keys` | Releases Fn and the modifier keys, if one is ever stuck. |

Run them as `node src/cli.ts <command>` from the repository.
