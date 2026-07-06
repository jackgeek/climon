# Feature catalogue

This catalogue records durable, user-visible climon capabilities. Use `cli-` for
Rust client, installer, update, and command-line features; use `dashboard-` for
browser/server features; use `security-` for security controls.

## Maintaining this document

- Add a stable ID when a feature ships or its user-facing contract changes.
- Keep entries concise and link to deeper architecture, setup, usage, or manual
  test docs instead of duplicating full runbooks here.
- Preserve IDs once published so changelogs, tests, and support notes can refer
  to them.

## CLI / installer / update

### cli-windows-binary-lifecycle — Windows-safe binary lifecycle

Windows installs use stable `climon.exe` and `climon-server.exe` stubs plus
versioned payloads selected by `climon.version` and `climon-server.version`.
Self-updates write new versioned files and flip pointers instead of overwriting a
locked running executable; open terminals keep the old code until restarted, and
`climon cleanup` reaps superseded unlocked payloads. Unix installs keep the
standard `climon` executable and rename-over update behavior.

See [architecture](architecture.md#binary-lifecycle-and-release-layout),
[setup](setup.md#making-climon-available-on-your-path), and the
[manual tests](manual-tests/windows-binary-lifecycle.md).
