# Architecture

The bridge is one Node.js process with three sides: the device, T3 Code
servers, and the desktop app. The `Controller` (`src/controller.ts`) sits in
the middle.

```
Creator Micro / Codex Micro                T3 Code servers (1..n)
  (vendor HID, report 6)                   (WebSocket RPC, /ws)
          │  keys, knob, stick                     │  thread shells, config
          ▼                                        ▼
   CodexMicroDevice ──input──▶ Controller ◀──change── T3Environment
   (src/device)     ◀─frames──  (slots,    ──commands─▶ (src/t3)
                                 actions,
                                 lighting)
                                    │
                                    ▼  open thread, press shortcut, hold Fn
                                  Host (src/host)  ──▶  T3 Code desktop app
                                    ▲
                     SidebarScopeWatcher (sidebar's project filter)
```

## Device (`src/device`)

The keyboard exposes a vendor HID collection: usage page `0xFF00`, report ID
6, with 63-byte input and output reports. Every report carries `[channel,
length, payload…]`. Channel 2 carries newline-delimited JSON-RPC, and
channel 1 carries firmware logs. The Codex Micro (`303a:8360`) and the
Creator Micro 2 (`303a:8297`, `303a:8298`) speak the same protocol.

- **Input:** notifications `v.oai.hid` `{k, act}` for keys (`AG00`–`AG05`,
  `ACT06`–`ACT12`, `ENC_CW`/`ENC_CC` with `act: 2`, `ENC_CLK`), and
  `v.oai.rad` `{a, d}` for the joystick (angle and distance, both 0–1).
- **Output:** `v.oai.thstatus` takes six entries `{id, c, b, e, s, sk, sa}`
  for the agent keys. `v.oai.rgbcfg` takes `{keys, ambient}` zones for the
  backlight and ring. Effects: 0 off, 1 solid, 2 snake, 4 breath,
  6 shallow breath.
- **Framing** depends on the OS and transport, and a wrongly framed write
  still "succeeds" while the device ignores it. `CodexMicroDevice.connect`
  therefore tries each framing until `device.status` answers.
- **Writes are serialized** (the firmware handles one request at a time) and
  deduplicated against what was last applied, so state churn doesn't
  flicker.
- **Discovery** polls every two seconds, prefers USB over Bluetooth, and
  reopens a handle that dies silently, for example after sleep.

`lighting.ts` turns a `LightingModel` into a firmware frame, following the
Codex app's factory behaviour: solid status colours, a breathing selected key,
a dark backlight, and a ring that lights only for voice, a working
selection, or a short flash after the selection moves.

## T3 Code (`src/t3`)

`RpcConnection` speaks Effect RPC's JSON protocol over
`ws(s)://<server>/ws?orchestrationProtocol=2`, authenticated with an
`Authorization: Bearer` header:

- It sends `Request` messages, receives `Chunk` and `Exit`, acknowledges
  every `Chunk` with `Ack`, and keeps the socket alive with `Ping`/`Pong`.
- Subscriptions are re-sent after every reconnect.

`T3Environment` holds one server's state:

- **Config:** `server.getConfig`, for the environment id, keybindings,
  providers (model options) and the scratch workspace.
- **Threads and projects:** `orchestration.subscribeShell`. A snapshot
  *without* `resolvedRepositoryIdentityRoots` replaces everything; one *with*
  it refreshes projects only. Events with a sequence at or below the
  snapshot's are ignored.
- **Commands:** `orchestration.dispatchCommand`, for
  `runtime-request.respond` (approve/decline), `run.interrupt`/`thread.stop`,
  `thread.fork`, `thread.interaction-mode.set` and
  `thread.model-selection.set`.

## Model (`src/model`)

- **`threadStatus`** follows T3 Code's sidebar (`resolveSidebarThreadStatus`)
  and folds it into the device's colours: needs input, working, error, done
  (finished after your last visit), or idle. A subagent waiting on you lights
  its parent.
- **`candidateThreads`** keeps visible top-level threads, then applies the
  sidebar's project filter and hides settled threads that are idle.
- **`assignSlots`** fills the six keys by `agentSource`, keeping a thread on
  its key while it stays in the top six.
- **`attentionQueue`** orders every candidate for `nextAttention`.
- **`projectScopeKeys`** lists every key the sidebar might use for a project
  (repository, repository subfolder, physical path, or the "No project"
  key), so the filter matches whatever grouping mode the app uses.

## Host (`src/host`)

On macOS:

- **Opening threads:** `open [-g] t3code://threads/<environment>/<thread>`.
- **Shortcuts:** the bridge brings the app forward with `open -a`, waits for
  it to be frontmost (checked by bundle id), then posts CoreGraphics key
  events from a HID-state event source through `osascript -l JavaScript`.
  System Events refuses keystrokes from a background agent even with
  Accessibility granted, and only real events can hold Fn. All key events go
  through one queue, so a release never overtakes its press.
- **Sidebar filter:** the app stores `sidebarProjectScopeKey` in its
  renderer's localStorage, which Chromium keeps as LevelDB.
  `SidebarScopeWatcher` reads the newest write from the uncompressed `.log`
  file whenever the folder changes. It accepts Latin-1 and UTF-16 values,
  and keeps the last known filter after a compaction.
- **Permissions:** `install` copies the Node binary into a small, ad-hoc
  signed app bundle (`~/Applications/Codex Micro for T3 Code.app`). It then
  runs the bridge from that bundle as a login agent. Input Monitoring and
  Accessibility attach to that bundle's identity and survive edits to the
  scripts.

On Linux, threads open with `xdg-open` and shortcuts go through `wtype` or
`xdotool`.

## Design rules

- **Never guess between threads.** Approve, decline and stop act on the
  selected thread, or on the only qualifying thread on the keys.
- **Never type into the wrong app.** On macOS, shortcuts are only sent once
  T3 Code is confirmed frontmost. Push-to-talk's held key is system-wide by
  design, and the Linux host sends to the active window.
- **Least privilege.** Tokens need only `orchestration:read` and
  `orchestration:operate`. Device calls from the CLI are limited to
  read-only methods.
- **Factory feel.** Timings (350 ms double tap, 500 ms knob hold, 100 ms
  input-quiet lighting debounce, 3-minute auto-dim) match the Codex app.

## Testing

`pnpm test` runs `node:test` suites with fake environments, a fake host and
mock timers; no device or server is needed. `pnpm typecheck` runs
TypeScript in strict mode. The sources are plain TypeScript that Node runs
directly, so there's no build step.
