# Security Policy

## Reporting a vulnerability

Please **don't** open a public issue. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/colemorgan/creator-micro-t3-code/security/advisories/new).
You'll get an acknowledgement within a few days. Once there's a fix, the
issue will be disclosed in the release notes, crediting you if you'd like.

Only the latest commit on `main` is supported.

## What the bridge can do

The bridge acts on your behalf, so it holds sensitive access. The things to
know:

- **T3 Code tokens.** These are stored in
  `~/.config/codex-micro-t3/config.json`, which only your user can read
  (mode `0600`). Create them with only `orchestration:read` and
  `orchestration:operate`: they can read threads and approve, decline,
  interrupt, fork and change the model settings of threads. Revoke one with
  `t3 auth session revoke`.
- **Network.** The bridge only connects to the T3 Code servers you pair.
  Prefer `https`, or a private network such as Tailscale, for remote servers,
  because the token travels in the WebSocket handshake.
- **macOS permissions.** The app bundle needs Input Monitoring (to read the
  keyboard) and Accessibility (to post key events). It only posts keys
  while T3 Code is the frontmost app, and only holds a key while push-to-talk
  is active.
- **Device.** CLI device calls are limited to read-only methods. The bridge
  never writes the keyboard's filesystem or firmware.
- **App storage.** To follow the sidebar's project filter, the bridge reads
  the T3 Code desktop app's localStorage files without modifying them.

Reports about any of these crossing their stated limits are in scope.
