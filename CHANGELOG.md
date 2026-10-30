# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Linux setup steps (udev rule and systemd user unit), and a setup report
  issue template for feedback.

## [0.1.0] - 2026-10-27

### Added

- Bridge between the Work Louder Codex Micro / Creator Micro 2 and T3 Code,
  using the keyboard's stock firmware over its vendor HID channel (USB or
  Bluetooth).
- Agent keys show six threads across every paired T3 Code server, in the
  Codex status colours, with tap to open and double-tap to bring the app
  forward.
- The command keys, knob and joystick follow the Codex factory layout: fast
  mode, approve, decline, fork, push-to-talk, send, plan mode, back/forward,
  sidebar, and navigation/reasoning/agents knob modes.
- `nextAttention` steps through every thread that needs a look.
- The keys follow the T3 Code sidebar's project filter and hide settled
  threads.
- Push-to-talk works with macOS Dictation, with hold-to-talk apps
  (Typeless, Wispr Flow) and with toggle shortcuts.
- Factory lighting behaviour, with auto-dim.
- macOS login agent, installed as an ad-hoc signed app bundle so
  permissions stay stable.
- `status`, `doctor`, `permissions`, `action`, `rpc` and `release-keys`
  diagnostics.

[Unreleased]: https://github.com/colemorgan/creator-micro-t3-code/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/colemorgan/creator-micro-t3-code/releases/tag/v0.1.0
