# Manual test plan

Explicit, human-run test cases that prove each feature is implemented correctly,
with **configuration matrices** for cross-environment behaviour that CI cannot
realistically exercise (real browsers, WSL↔Windows bridges, remote tunnels,
per-OS PTY/transport backends).

This directory grows lockstep with the [Rust client
rewrite](../superpowers/plans/2026-06-17-rust-client-rewrite-master-plan.md): each
phase authors its manual cases here as part of its definition of done.

**Every new feature MUST add manual checks here as part of its definition of
done** — not only rewrite phases. Add or update a feature file (see
[Test-case shape](#test-case-shape)) and link it from [Cases by phase](#cases-by-phase).

## Layout

- `README.md` — this index.
- `configuration-matrix.md` — top-level matrix dimensions and cross-environment
  cells (added when the first cross-environment phase lands).
- `phaseNN-<feature>.md` — one file per phase/feature, each holding full test
  cases.
- `results/<version>.md` — per-release results snapshot: versioned, diffable
  result tables recording pass/fail per matrix cell with date, tester, and notes.

## Test-case shape

Each case records: **ID**, feature/phase, preconditions, config-matrix cell
(where applicable), numbered steps, expected result, platforms, and a
result-tracking row.

## Cases by phase

| Phase | Feature | File |
|---|---|---|
| 1 | Client/server split — compiled `climon-server` binary | [phase01-client-server-split.md](phase01-client-server-split.md) |
| 2 | Cargo workspace + `climon-proto` crate (frame/meta wire parity, license tooling) | [phase02-workspace-proto.md](phase02-workspace-proto.md) |
| 3 | `climon-config` crate (JSONC parse/render parity, cascade + legacy migration, docs generator) | [phase03-config.md](phase03-config.md) |
| 4 | `climon-logging` crate (levels, redaction parity, pretty/sinks, CLI I/O) | [phase04-logging.md](phase04-logging.md) |
| 5 | `climon-store` crate — atomic metadata IO, patch serialization, session ids, server state | [phase05-store.md](phase05-store.md) |
| 6 | climon-pty crate — cross-platform PTY spawn/resize, raw-mode termios/ConPTY, scrollback, terminal size | [phase06-pty.md](phase06-pty.md) |
| 7 | climon-session crate — session host: PTY ownership, per-session IPC socket, scrollback shadow, idle/attention, frame relay, title broadcast, local relay, lifecycle | [phase07-session.md](phase07-session.md) |
| 8 | climon-cli core — daily-driver `climon` client: arg parser, launcher (run/shell/ls/kill), attach client + detach, config/server delegation, license notices, version-from-package.json | [phase08-cli.md](phase08-cli.md) |
| 9 | climon-remote crate — uplink/ingest mux bridge (byte-exact wire), devtunnel detection, WSL↔Windows link/discovery, keepalive, singleton recycle, demotion, cleanup; wired `__uplink`/`__ingest`/`link`/`cleanup` + launcher auto-uplink/auto-link | [phase09-remote.md](phase09-remote.md) |
| 10 | climon-update — self-update: byte-for-byte Ed25519 verify + AES-256-GCM/scrypt envelope decrypt, release manifest, atomic no-kill binary swap, background check + launch banner, `climon update` | [phase10-update.md](phase10-update.md) |
| 11 | climon-install — client-side install/setup: install-manifest + on-disk layout parity, PATH setup (macOS/Linux/Windows), `climon setup` onboarding, telemetry/auto-update opt-in, stable install id, running-process detection | [phase11-install.md](phase11-install.md) |
| 12 | Cutover & cleanup — ship the Rust `climon` client as the `install` binary, native Rust self-install (sentinel `climon-alpha` trigger, PATH + `.version` + changelog, locked-binary kill/retry), `scripts/compile.ts` host/assemble modes, `release.yml` cross-compile matrix, retire the Bun client bin | [phase12-cutover.md](phase12-cutover.md) |
| — | Pin key bar (mobile) — mobile-only hamburger toggle + centralised mobile detection | [pin-key-bar.md](pin-key-bar.md) |
| — | Mobile active-session layout order — Open terminal button between title and status/client meta | [mobile-open-terminal-order.md](mobile-open-terminal-order.md) |
| — | Tunnel-link expiry countdown banner | [phase13-tunnel-expiry-banner.md](phase13-tunnel-expiry-banner.md) |
| — | WSL bridge feature flag — config-driven remotes ingest + explicit bridge opt-in | [phase14-wsl-bridge-feature-flag.md](phase14-wsl-bridge-feature-flag.md) |
| — | Ingest Rust cutover — production Rust ingest, control-plane parity, ghost GC, gate #3, hardening | [phase15-ingest-rust-cutover.md](phase15-ingest-rust-cutover.md) |
| — | Remotes visibility — `ingest-status.json`/`uplink-status.json` beacons, `climon remotes` (`--watch`/`--json`), loopback `GET /api/remotes` + SSE, dashboard "Remote hosts" panel, hello identity sanitization | [phase16-remotes-visibility.md](phase16-remotes-visibility.md) |
| — | Legacy Bun client removal — Rust client plus maintained Bun dashboard/server workflow | [phase17-legacy-client-removal.md](phase17-legacy-client-removal.md) |
| — | Dev tunnel re-auth (PWA) | [dev-tunnel-reauth.md](dev-tunnel-reauth.md) |
| — | PWA notification click opens the originating session terminal | [pwa-notification-click.md](pwa-notification-click.md) |
| — | PWA zoom lock & no overscroll (pinch-zoom disabled, page pinned 1:1 on swipe) | [pwa-zoom-lock.md](pwa-zoom-lock.md) |
| — | Security — Web Push endpoint SSRF guard | [security-push-ssrf.md](security-push-ssrf.md) |
| — | Dashboard preferences (shared theme picker + key-bar pin) | [dashboard-preferences.md](dashboard-preferences.md) |
| — | Per-session theme + default theme (CLI `--theme`, Edit/New dialogs, live inheritance) | [per-session-theme.md](per-session-theme.md) |
| — | Windows — no console-window popups from remote child processes (`devtunnel`/`tasklist`/`taskkill`/peer discovery) | [windows-no-console-popups.md](windows-no-console-popups.md) |
| — | Security — WebSocket attach Origin validation | [security-ws-attach-origin.md](security-ws-attach-origin.md) |
| — | Security DNS-rebinding guard for dashboard reads/delete | [security-dns-rebind.md](security-dns-rebind.md) |
| — | Security — project-local config global-only settings | [security-config-global-only.md](security-config-global-only.md) |
| — | Interactive install opt-ins default to Yes (telemetry + auto-update prompts) | [optin-default-yes.md](optin-default-yes.md) |
| — | Remove `climon-beta` from the distribution (zip/install/update orphan cleanup) | [remove-climon-beta.md](remove-climon-beta.md) |
| — | Ingest hosts the remotes dev tunnel (`devtunnel host`) — devbox connects + appears in flyout | [ingest-tunnel-host.md](ingest-tunnel-host.md) |
| — | MIT license transition — `climon license`, one-time upgrade notice, no notice on fresh installs | [mit-license-transition.md](mit-license-transition.md) |
| — | Text staging area — icon-only keybar chooser + full-viewport compose overlay (Insert / Insert & Run / Cancel) | [text-staging-area.md](text-staging-area.md) |

## Recording results

Copy the result-tracking row from a case into `results/<version>.md` and fill in
date, tester, platform, and pass/fail when you run it against a release
candidate.
