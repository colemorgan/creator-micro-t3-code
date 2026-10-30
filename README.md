<img src="assets/icon.svg" width="64" height="64" alt="">

# Creator Micro for T3 Code

[![CI](https://github.com/colemorgan/creator-micro-t3-code/actions/workflows/ci.yml/badge.svg)](https://github.com/colemorgan/creator-micro-t3-code/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Use a Work Louder **Creator Micro 2** or **Codex Micro** with
[T3 Code](https://t3.codes), the way the ChatGPT desktop app uses it for
Codex. The six agent keys show your threads' status, and the other keys
approve, decline, fork, send, and push-to-talk.

The keyboard keeps its stock firmware. Its firmware already reports every key,
the knob and the joystick, and accepts lighting commands, over a vendor HID
channel. This bridge is a small background program that reads that channel.
It drives T3 Code through the T3 Code server's API and a few app shortcuts.

> **Status:** early (0.1). It's used daily on macOS with a Creator Micro 2
> over Bluetooth and T3 Code 0.1.3. Other setups should work, but nobody has
> tested them yet. If you try it, please
> [file a setup report](https://github.com/colemorgan/creator-micro-t3-code/issues/new?template=setup_report.yml),
> whether it worked or not.

## What the keys do

The keys follow the Codex factory layout, mapped to T3 Code:

| Control | Action |
|---|---|
| **Agent keys 1–6** | Six threads across all your T3 Code servers. Each colour is a status: white is idle, blue is working, green is finished but unread, amber needs you, and red is an error. The selected thread's key breathes. Tap a key to open its thread in the background; double-tap to also bring T3 Code forward. |
| **FAST** | Toggles Fast mode on the selected thread: Claude's Fast Mode, or Codex's priority tier. |
| **APPR / REJ** | Approves or declines the selected thread's pending request. If the selected thread has none, it acts on the only waiting thread among the keys. |
| **SPLIT** | Forks the selected thread and opens the fork. |
| **MIC** (wide key) | Push to talk: hold to record. Double-tap to keep recording, and tap again to stop. |
| **CODEX** | Sends the composer. |
| **Joystick** | Up toggles Plan mode, left/right go back/forward, and down toggles the sidebar. |
| **Knob** | Turning sends ↑/↓ and clicking sends Enter, so it can drive pickers. Hold the knob to switch modes: **Reasoning** (turning changes effort) or **Agents** (turning steps through the agent keys). The ring flashes the mode's colour. |

**Which threads get keys.** The keys follow the T3 Code sidebar. When the
sidebar is filtered to a project, only that project's threads get keys.
Settled threads are left off unless they're working or need you. The order
of the remaining threads is configurable: most recent, most urgent, or your
pinned threads.

**When there are more than six threads.** Map any key to `nextAttention`. Each
press opens the next thread that needs a look, in this order: needs you,
error, finished and unread, then working. It covers every matching thread,
not just the six on keys.

Every control can be remapped: see [Configuration](docs/configuration.md).

**Lighting** follows the factory behaviour. The ring stays dark except while
you're recording, while the selected thread is working, or briefly after the
selection changes. Everything goes dark after three minutes of inactivity.

## Requirements

- A Work Louder **Creator Micro 2** (switched to its **Codex layer**) or a
  **Codex Micro**, connected over USB or Bluetooth.
- **macOS** for the full feature set. On Linux, the device, lights and
  server actions work; keyboard shortcuts need `wtype` or `xdotool`, and
  following the sidebar filter is macOS-only.
- **Node.js 24+** and **pnpm**.
- **T3 Code** 0.1.x (desktop app, and/or a remote T3 Code server).

## Quick start (macOS)

```sh
git clone https://github.com/colemorgan/creator-micro-t3-code.git ~/creator-micro-t3-code
cd ~/creator-micro-t3-code
pnpm install
```

Connect it to T3 Code. For each server you use (the desktop app's own server
listens on port 3773), create a token that can only read and operate threads.
Run `t3 auth session issue` on the machine that runs that server, then run
`pair` here, on the machine with the keyboard:

```sh
t3 auth session issue --scope orchestration:read --scope orchestration:operate \
  --label "Creator Micro bridge" --token-only
node src/cli.ts pair http://127.0.0.1:3773 <token>
node src/cli.ts pair http://<remote-host>:3773 <token>   # optional, per remote server
```

The bridge expects the **T3 Code (Beta)** app. If you use another build, set
`app.name` in the config first: see [Configuration](docs/configuration.md#app).

The token travels in the connection handshake. For a remote server, use
`https://`, or plain `http://` only over a private network you trust, such as
Tailscale.

Install it to start at login:

```sh
node src/cli.ts install
```

This creates `~/Applications/Codex Micro for T3 Code.app` and a login agent.
In **System Settings → Privacy & Security**, turn on **Codex Micro for T3
Code** under both **Input Monitoring** and **Accessibility**. Then run:

```sh
node src/cli.ts restart
```

Finally:

1. Quit the ChatGPT desktop app, which drives the same lights.
2. Switch the keyboard to its Codex layer.
3. Check what the bridge sees:

```sh
node src/cli.ts status                 # servers, and what each agent key shows
node src/cli.ts session doctor         # device check, light test, live input
```

Logs are in `~/Library/Logs/codex-micro-t3.log`.

## Setup on Linux

Linux support is untested so far. Clone, install and pair as above, then:

1. Install `wtype` (Wayland) or `xdotool` (X11) for keyboard shortcuts.
   `wtype` needs a compositor with the virtual-keyboard protocol, such as
   Sway or Hyprland. GNOME and KDE Plasma don't offer it to `wtype`, so on
   their Wayland sessions the keyboard shortcuts don't work. The lights and
   the server actions still do.
2. Let your user open the keyboard. `/dev/hidraw*` is root-only by default.
   Create `/etc/udev/rules.d/70-creator-micro.rules`:

   ```
   # USB
   KERNEL=="hidraw*", ATTRS{idVendor}=="303a", TAG+="uaccess"
   # Bluetooth
   KERNEL=="hidraw*", KERNELS=="*:303A:*", TAG+="uaccess"
   ```

   Then run `sudo udevadm control --reload && sudo udevadm trigger`, and
   reconnect the keyboard.
3. Check it, then run it:

   ```sh
   node src/cli.ts doctor
   node src/cli.ts run
   ```

To start it with your desktop session, create a systemd user unit at
`~/.config/systemd/user/creator-micro-t3.service`. Replace the paths with
your own `which node` and clone location:

```ini
[Unit]
Description=Creator Micro bridge for T3 Code
PartOf=graphical-session.target
After=graphical-session.target

[Service]
ExecStart=/usr/bin/node %h/creator-micro-t3-code/src/cli.ts run
Restart=on-failure

[Install]
WantedBy=graphical-session.target
```

Then run `systemctl --user enable --now creator-micro-t3`. Logs are in
`journalctl --user -u creator-micro-t3`.

## Feedback

This is a young project with few users, so every report helps:

- **[Setup report](https://github.com/colemorgan/creator-micro-t3-code/issues/new?template=setup_report.yml)**:
  how setup went on your keyboard and OS, whether it worked or not.
- **[Bug report](https://github.com/colemorgan/creator-micro-t3-code/issues/new?template=bug_report.yml)**:
  something doesn't behave as documented.
- **[Feature request](https://github.com/colemorgan/creator-micro-t3-code/issues/new?template=feature_request.yml)**:
  an action or mapping you'd like.

## Documentation

- [Configuration](docs/configuration.md): every option and action
- [Troubleshooting](docs/troubleshooting.md): permissions, layers, stuck keys
- [Architecture](docs/architecture.md): how the device protocol, T3 Code API
  and macOS integration fit together
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) ·
  [Code of Conduct](CODE_OF_CONDUCT.md) · [Changelog](CHANGELOG.md)

## Credits

- The HID framing and agent-key assignment are adapted from Hormold's in-app
  T3 Code integration,
  [pingdotgg/t3code#23869](https://github.com/pingdotgg/t3code/pull/23869)
  (MIT).
- The Codex factory behaviour (colours, timings, key layout) follows
  [FreeMicro](https://github.com/eliBenven/freemicro)'s interoperability notes,
  and [work-louder-oai](https://github.com/boopdotpng/work-louder-oai)'s
  protocol notes.

## Disclaimer

This is an independent project. It isn't affiliated with or endorsed by Work
Louder, OpenAI, or T3 Tools. "Creator Micro" and "Codex Micro" are Work
Louder's names, "Codex" and "ChatGPT" are OpenAI's, and "T3 Code" is T3
Tools'. They're used here only to describe compatibility.

## License

[MIT](LICENSE)
