# Troubleshooting

Start with these two:

```sh
node src/cli.ts status            # servers, sidebar filter, what each key shows
node src/cli.ts session doctor    # device check, light test, live input
```

Logs are in `~/Library/Logs/codex-micro-t3.log`. For more detail, set
`"logLevel": "debug"` in the config and restart.

## The keys don't light up, or nothing happens when I press them

- **Switch the keyboard to its Codex layer.** On a Creator Micro 2, the other
  layers send ordinary keystrokes instead of agent-key events. To see the
  layers, run `node src/cli.ts session rpc fs.read '{"file":"keymap.json"}'`.
  The Codex layer's keys are `KV_OAI_*`.
- **Quit the ChatGPT desktop app.** It drives the same lights, and the two
  overwrite each other.
- **Check the bridge is running:**
  `launchctl print gui/$(id -u)/dev.t3.codex-micro | grep state`.
- **Bluetooth sleep:** after the keyboard wakes, the bridge reconnects within
  a few seconds. `device: disconnected` followed by `connected` in the log is
  normal.

## `not permitted` (0xE00002E2)

macOS is blocking the bridge from the keyboard. In **System Settings → Privacy
& Security → Input Monitoring**, turn on **Codex Micro for T3 Code**, then run
`node src/cli.ts restart`.

Running `doctor` directly over SSH always fails this way, because an SSH
session doesn't have that permission. Use `node src/cli.ts session doctor`,
which runs it through the app.

`node src/cli.ts session permissions` shows what the bridge has been granted.

## Shortcuts don't reach T3 Code (joystick, knob, Send)

- Turn on **Accessibility** for **Codex Micro for T3 Code** in **Privacy &
  Security**, then restart.
- If you use a different build of the app, set `app.name` to match, such as
  `T3 Code (Nightly)`.
- The bridge only types once T3 Code is frontmost. If the app can't come
  forward (for example, while a full-screen app or a system dialog is in
  front), the log shows `T3 Code did not come to the front`.
- Joystick commands press *your* T3 Code shortcuts. If you've unbound one,
  the ring flashes red and the log says `no shortcut is bound to …`.

## A modifier key is stuck (Space or other keys stop working)

`mic.mode: "hold"` holds a key such as Fn while you record. If something goes
wrong while it's held, macOS can be left thinking the key is still down. With
Fn held, Space turns into Fn+Space and stops typing. To recover, either:

- press and release the physical Fn (🌐) key once, or
- run `node src/cli.ts session release-keys`.

The bridge sends key presses and releases strictly in order, and releases any
held key when it stops, so this shouldn't happen. If it does, please
[open an issue](https://github.com/colemorgan/creator-micro-t3-code/issues)
with the log.

## Push-to-talk doesn't record

- **Typeless / Wispr Flow:** use `"mic": { "mode": "hold", "shortcut": "fn" }`,
  and check that the app's dictation shortcut really is Fn.
- **macOS Dictation** (`"mode": "dictation"`): Dictation must be turned on in
  **System Settings → Keyboard**.
- **Other apps:** use `"mode": "shortcut"` with the app's start/stop shortcut.

## Fast mode doesn't change

The Fast key changes the setting on the server, and also flips it in T3
Code's composer by opening the effort menu (⌘⇧E), jumping to the end, and
choosing the item there. If you've rebound **Composer: Effort**, the bridge
uses your shortcut. If the composer has its own setting for that thread, the
first press may land on the state it already had; press again.

## The agent keys show the wrong threads

- `status` prints the sidebar filter the bridge sees. If it doesn't match
  the app, check `app.dataDir`. The bridge reads the filter from
  `~/Library/Application Support/<dataDir>/Local Storage`.
- Settled threads are hidden while `followSidebar` is on; set it to `false`
  to include them.
- The selected key (the breathing one) follows the thread you most recently
  opened, in the app or with a key.

## Approve or Decline flashes red

Nothing on the selected thread is waiting for approval, and either no other
thread on the keys is waiting, or several are. The bridge never guesses
which one to answer. Select the thread you mean with its agent key first.

## Reconnecting to T3 Code

The bridge reconnects to each server on its own and resubscribes. If it
can't (the log shows `HTTP 401`), the token was revoked or has expired.
Create a new one, run `pair` again, then `node src/cli.ts restart`: the
running bridge only reads the config at startup.
