# Contributing

Thanks for helping. Bug reports, device reports ("works on my Codex Micro
over USB"), docs fixes and code are all welcome.

## Reporting a bug

[Open an issue](https://github.com/colemorgan/creator-micro-t3-code/issues/new/choose)
using the bug template. Include:

- your keyboard (Creator Micro 2 or Codex Micro), the connection (USB or
  Bluetooth), and the firmware version from `node src/cli.ts session rpc device.status`
  (macOS) or `node src/cli.ts rpc device.status` (Linux)
- your OS and Node version, and your T3 Code version
- the relevant part of `~/Library/Logs/codex-micro-t3.log`, with
  `"logLevel": "debug"` if you can reproduce it

Never paste your config file or tokens. For security problems, see
[SECURITY.md](SECURITY.md) instead of opening an issue.

## Development setup

```sh
git clone https://github.com/colemorgan/creator-micro-t3-code.git
cd creator-micro-t3-code
pnpm install
pnpm typecheck
pnpm test
```

Node runs the TypeScript sources directly, so there's no build step. Use
syntax Node can strip: no enums, namespaces or constructor parameter
properties (`erasableSyntaxOnly` enforces this).

You can work on most of the code without a device or a T3 Code server. The
tests use fake environments, a fake host and mock timers. To try changes
against real hardware, run `node src/cli.ts run` in a terminal that has
Input Monitoring and Accessibility, or deploy over your installed agent with
`node src/cli.ts install`.

[docs/architecture.md](docs/architecture.md) explains how the pieces fit
together.

## Pull requests

- Keep each PR to one change, and explain the user-visible effect in the
  description.
- Add or update tests for behaviour changes. `pnpm typecheck` and
  `pnpm test` must pass; CI runs both on Linux and macOS.
- Follow the surrounding style: small modules, plain functions, and
  comments that explain *why*.
- Update the docs (`README.md`, `docs/`) when you change what a key does or
  add a config option, and add a line to `CHANGELOG.md` under
  **Unreleased**.
- Device protocol facts must come from your own observation or published
  interoperability notes. Don't contribute code copied from proprietary apps.

## Licensing

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
