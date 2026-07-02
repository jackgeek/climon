<div align="center">

<img src="docs/assets/logo.jpg" alt="climon logo" width="160" />

# climon

**A web dashboard for your interactive CLI sessions — reachable from your phone.**

Prefix any command with `climon` to run it inside a managed pseudo-terminal, then
watch, interact with, and get notified about all of your sessions from one
dashboard — locally, or securely from your phone over an authenticated dev tunnel.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/jackgeek/climon)](https://github.com/jackgeek/climon/releases/latest)
![Platforms](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-informational)
![Client: Rust](https://img.shields.io/badge/client-Rust-orange)
![Server: Bun](https://img.shields.io/badge/server-Bun-black)

</div>

---

## Table of contents

- [Why climon?](#why-climon)
- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Configuration](#configuration)
- [Feature flags](#feature-flags)
- [Work from your phone](#work-from-your-phone-tunnel-link--pwa)
- [Remote sessions](#remote-sessions)
- [Updating](#updating)
- [Logging](#logging)
- [Build from source](#build-from-source)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Why climon?

You start a long build, a coding agent, a dev server, or a REPL, and then you
lose track of it behind a wall of terminal tabs. climon runs each command inside
its own detached pseudo-terminal and surfaces them all in a browser dashboard, so
you can:

- detach from a session (`Ctrl-\` then `d`) and the command keeps running under
  its own daemon,
- reattach from the CLI **or** drive it live from the browser,
- see at a glance which session is waiting on you,
- review the final output after a command finishes, and
- **check on and drive your sessions from your phone**, with push notifications
  when one needs attention — see [Work from your phone](#work-from-your-phone-tunnel-link--pwa).

## Features

- **Self-contained binaries.** The `climon` client is a native Rust binary using
  a portable PTY layer (openpty on Linux/macOS, ConPTY on Windows); the
  `climon-server` dashboard is a Bun binary using Bun's built-in HTTP/WebSocket
  server. No `node_modules` or separate runtime install is needed to run them.
  (The optional dev-tunnel remote feature is the one exception — it needs the
  Microsoft [`devtunnel`](https://learn.microsoft.com/azure/developer/dev-tunnels/)
  CLI.)
- **Sessions survive server restarts.** Each command runs under its own detached
  per-session daemon that owns the PTY. Restarting `climon server` never kills a
  running session.
- **Live web terminal.** The dashboard is a React + Fluent UI app embedding an
  `xterm.js` terminal wired to the session over a WebSocket — fully interactive,
  no iframe.
- **Attention queue.** While a session is attached, climon mirrors its output
  into a headless terminal and watches the rendered screen. If the visible
  content stops changing for `attention.idleSeconds` (default 10) — a blinking
  cursor counts as static — the session is flagged and bumped to the top of the
  dashboard.
- **Completion pops.** Finished sessions move up the queue and keep their final
  scrollback so you can review the output.
- **Themable dashboard.** Pick a terminal colour theme from the ☰ menu; the
  choice (and the mobile "Pin key bar" toggle) is saved in your config and shared
  across every browser and device.
- **Work from your phone (secure, opt-in).** Expose your local dashboard over an
  authenticated Microsoft dev tunnel with the **Tunnel Link** menu action, open it
  on your phone, and **Install as PWA**. You get a fully interactive web terminal
  plus **push notifications when a session needs attention** — even when the app
  is closed. The tunnel is not anonymous: only identities you grant access can
  reach it. See [Work from your phone](#work-from-your-phone-tunnel-link--pwa).
- **Remote & WSL bridging (experimental, opt-in).** Surface sessions from a
  remote devbox over a Microsoft [dev tunnel](https://learn.microsoft.com/azure/developer/dev-tunnels/),
  or bridge Windows and WSL on the same machine without a tunnel. See
  [Remote sessions](#remote-sessions).

## Install

The install scripts download the latest release for your platform, extract it,
and run climon's bundled self-installer (which places `climon` and
`climon-server` on your `PATH`).

> climon's release binaries are **not** code-signed or notarized yet. The install
> scripts fetch them with `curl`/`Invoke-WebRequest` and clear the OS
> "downloaded from the internet" mark (macOS quarantine / Windows Zone.Identifier)
> so they launch without a Gatekeeper or SmartScreen prompt. You can read the
> scripts before running them: [`install.sh`](install.sh) / [`install.ps1`](install.ps1).
> Later `climon update` downloads are still verified against climon's embedded
> Ed25519 signing key.

**Linux / macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/jackgeek/climon/main/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/jackgeek/climon/main/install.ps1 | iex
```

Prefer to install by hand? Download the archive for your platform from the
[latest release](https://github.com/jackgeek/climon/releases/latest)
(`climon-<platform>.zip`), unzip it, and run the bundled `install` (`install.exe`
on Windows). See [Build from source](#build-from-source) to build the binaries
yourself.

On first run, climon walks you through a short onboarding flow: opt in to
anonymous telemetry (**off** by default) and background auto-update (**off** by
default). Re-run it any time with `climon setup`.

## Quick start

```sh
climon server        # terminal 1: start the dashboard (http://127.0.0.1:3131)
```

```sh
climon bash          # terminal 2: run any command in a monitored session
```

Open <http://127.0.0.1:3131> and click a session.

## Commands

### `climon <command> [args...]`

Run any command inside a monitored PTY session — a build, a REPL, a coding agent,
a dev server. Detach with `Ctrl-\` then `d` and the command keeps running under
its own daemon, so you can keep tabs on it from the dashboard or reattach later
from the CLI.

```sh
climon bash                  # monitor an interactive shell
climon copilot               # monitor a coding agent session
climon npm run dev           # monitor a dev server
```

Tag a session at launch with organizing metadata, placed **before** the command:

```sh
climon --priority 100 --color red --name "dev server" npm run dev
```

- `--priority N` — an integer `0–1000` (default `500`) controlling sort order in
  the dashboard and `climon ls`; lower sorts to the top.
- `--color C` — one of `black`, `red`, `green`, `yellow`, `blue`, `magenta`,
  `cyan`, `white`, `none`, or `auto`; shown as a coloured accent on the session.
- `--name S` — a friendly label shown instead of the command. It is also used as
  the terminal window title and updates live if you rename the session from the
  dashboard. When omitted, climon adopts the terminal's current title if
  available; otherwise the command is shown. Disable all title behaviour with
  `climon config terminal.setTitle false`.
- `--theme T` — a dashboard terminal theme for this session by display name (e.g.
  `"Dracula"`); an unrecognised name falls back to the dashboard default.

All three can also be changed from the dashboard by clicking the **cog** button
on a session.

### `climon server [--port N] [--no-takeover]`

Start the web dashboard. It serves the UI at <http://127.0.0.1:3131> and connects
to all running session daemons over WebSocket.

- `--port N` — use a custom port instead of the default `3131`.
- `--no-takeover` — never terminate (or prompt to terminate) an already-running
  dashboard; instead start a second server on the next free port. Useful for
  throwaway dashboards.

By default the dashboard binds to loopback (`127.0.0.1`). To expose it to other
machines on your network, set the bind address in config:

```sh
climon config server.host 0.0.0.0
```

Running `climon server` locates and runs the `climon-server` binary — via
`CLIMON_SERVER_BIN`, then a sibling binary next to `climon`, then your `PATH`.

### `climon ls`

List all monitored sessions with their IDs, status, and command. Use it to find
the session ID for `attach` or `kill`. (`climon list` is an alias.)

### `climon attach <id>`

Reattach your terminal to a running session — for example to type into a REPL or
respond to a prompt from the CLI instead of the browser.

Detach again without stopping the command with `Ctrl-\` then `d`.

### `climon kill <id>`

Terminate a monitored session and its underlying process. Use `climon kill --all`
to stop every session.

### `climon remotes`

Show which remote hosts are currently connected (and, on a devbox, the dashboard
this machine's uplink is connected to). Healthy entries are marked `●` and stale
ones `○`. Use `--watch` for a live view or `--json` for a machine-readable
snapshot.

### `climon link`

Link a same-machine Windows/WSL pair so their sessions share one dashboard. See
[Remote sessions](#remote-sessions).

- `--wsl-bridge` — non-interactively opt in to the WSL bridge.
- `--peer-home <path>` — point at the peer's climon home explicitly.

### `climon setup`

Re-run the first-run onboarding flow (telemetry and auto-update opt-in).
Interactive by default; for scripted setup:

```sh
climon setup --apply --telemetry=off --auto-update=off
```

- `--apply` — run non-interactively; apply the provided flags.
- `--telemetry=on|off` — anonymous usage telemetry (default **off**).
- `--auto-update=on|off` — background auto-update (default **off**).

These map to the `telemetry.enabled` and `update.auto` config settings.

### `climon update`

Download, verify, and apply the latest released version. The downloaded
artifact's Ed25519 signature is verified against the embedded public key before
anything is replaced; tampered or unverifiable downloads are rejected. Updates
are **non-destructive** — they never kill running sessions or a running
dashboard, and already-running processes keep using the old code until they
restart. See [Updating](#updating).

### `climon cleanup`

Tear down this machine's dashboard, ingest, and uplink. Useful when a WSL/Windows
takeover cannot be confirmed and climon asks you to clean up a side.

### `climon config <key> [value] [--local|--global] [--debug]`

Read or write configuration. With no value it prints the current value; with a
value it writes it. Use `--debug` to print every config file climon considered,
in resolution order. See [Configuration](#configuration).

### `climon license`

Print climon's licence and third-party attributions.

## Configuration

Configuration is filesystem-backed under `$CLIMON_HOME` (default `~/.climon`).
The canonical file is `config.jsonc` (JSON with comments). Settings are resolved
**hierarchically**: climon looks for `.climon/config.jsonc` in the current
directory, walks up each parent directory, then falls back to the global
`$CLIMON_HOME/config.jsonc`. This lets you set per-repo defaults (e.g. always
green, priority 20) and a different global default. Legacy `config.json` files
are still read for backward compatibility and migrated on first write.

Writes go to the nearest existing config, or use `--local` / `--global` to choose
explicitly:

```sh
climon config server.port 8080 --global
climon config session.color green --local
climon config --debug              # show all config files in resolution order
```

Common settings:

| Key | Default | Purpose |
| --- | --- | --- |
| `server.host` | `127.0.0.1` | Dashboard bind address (`0.0.0.0` to expose on LAN). |
| `server.port` | `3131` | Dashboard port. |
| `attention.idleSeconds` | `10` | Idle seconds before a session is flagged for attention. |
| `terminal.setTitle` | `true` | Whether climon sets the terminal window title. |
| `terminal.clampBrowserToHost` | `false` | Clamp browser viewer resizes to the host terminal size. |
| `dashboard.theme` | `Default` | Terminal colour theme (also settable from the ☰ menu). |
| `session.color` | `auto` | Default accent colour for new sessions. |
| `session.priority` | `500` | Default sort priority for new sessions. |
| `telemetry.enabled` | `false` | Anonymous usage telemetry. |
| `update.auto` | `false` | Background auto-update. |
| `logging.level` | `trace` | Log verbosity (`trace`…`fatal`, or `silent`). |

Run `climon config` without arguments, or see [docs/usage.md](docs/usage.md) for
the full list.

## Feature flags

Several capabilities are **experimental and disabled by default**, gated behind
flags under the `feature.` prefix. Each accepts `"enabled"` or `"disabled"`:

| Flag | Enables |
| --- | --- |
| `feature.sessionSpawning` | Spawning new sessions from the dashboard (the per-session and global **[+]** buttons). |
| `feature.remotes` | Connecting a remote devbox's sessions to this dashboard over the ingest/uplink bridge. |
| `feature.remoteSpawn` | Spawning sessions on a remote devbox over a signed command channel. |
| `feature.wslBridge` | Streaming sessions between a same-machine WSL distro and Windows. |

Enable one with, for example:

```sh
climon config feature.sessionSpawning enabled
```

Once `feature.sessionSpawning` is on, hover any live session and click its
**[+]** to launch a new session from it (inheriting its working directory and
metadata); when there are no sessions, a global **[+]** appears in the sidebar.
For security, all dashboard-initiated session creation only works from the
machine running the server (loopback) — remote/LAN clients cannot create
sessions.

## Work from your phone (Tunnel Link + PWA)

Your dashboard normally binds to loopback only. To reach it from your phone (or
any other device) without exposing it to the network, use **Tunnel Link**:

1. From the dashboard's ☰ menu, choose **Tunnel Link**. climon starts an
   authenticated Microsoft [dev tunnel](https://learn.microsoft.com/azure/developer/dev-tunnels/)
   in front of your local dashboard and gives you an HTTPS `*.devtunnels.ms` URL.
   The tunnel is **not anonymous** — only identities you've granted access can
   open it — and it stays up until you choose **Close Tunnel Link**.
2. Open the link on your phone and tap **Install as PWA** to add climon to your
   home screen.
3. Enable notifications from the menu to receive **Web Push alerts when a session
   needs attention** — even when the app is closed.

From the phone you get the same fully interactive web terminal, so you can check
on and drive your sessions remotely. If the tunnel sign-in expires, the PWA
prompts you to sign in again; it never stores tunnel credentials in the browser.

> **Requires the `devtunnel` CLI** on the machine running the dashboard. When the
> tunnel closes, the installed PWA shows a banner asking you to uninstall it.

- Android (Chrome): **Install as PWA → Install**.
- iPhone (Safari, iOS 16.4+): **Share → Add to Home Screen**, then open climon
  from the new icon and enable notifications.

See [docs/usage.md](docs/usage.md) and [docs/security.md](docs/security.md) for
the tunnel identity model and push-subscription details.

## Remote sessions

climon can also surface sessions from another machine in your dashboard. These
paths are opt-in.

### Remote devbox over a dev tunnel

Enable `feature.remotes`, start a local server, then open **Remotes…** from the
dashboard menu to create (or paste) a Microsoft
[dev tunnel](https://learn.microsoft.com/azure/developer/dev-tunnels/) and copy a
config script to run on the devbox. The transport exposes a loopback-only ingest
port on the home machine — there is no SSH and no network-exposed dashboard.

> **Requires the `devtunnel` CLI** on both the home machine (to host the tunnel)
> and the devbox (to connect through it), each logged in with the same identity
> (`devtunnel user login`).

See [docs/usage.md](docs/usage.md) and [docs/security.md](docs/security.md) for
the full setup and threat model.

### Windows ↔ WSL on the same machine (no tunnel)

Install climon on Windows, run `climon server`, then run `climon link` in WSL and
opt in to the bridge when prompted:

```sh
climon link                 # auto-detect the peer and prompt
climon link --wsl-bridge    # non-interactive opt-in
```

Sessions only stream across the OS boundary once `feature.wslBridge` is enabled
on both sides. You can host the dashboard from either OS and switch at will. See
[docs/usage.md](docs/usage.md#connecting-windows-and-wsl-on-the-same-machine).

## Updating

`climon update` fetches the release manifest from
`https://github.com/jackgeek/climon/releases/latest/download/manifest.json`,
verifies each artifact's Ed25519 signature against the embedded public key, and
only then swaps binaries — atomically and without killing running sessions or the
dashboard. When auto-update is off (the default), climon prints a one-line banner
suggesting `climon update` when a newer version is available.

## Logging

climon logs to `$CLIMON_HOME/logs/` using structured logging. Control verbosity
with `logging.level` in config or the `CLIMON_LOG_LEVEL` environment variable
(`trace`…`fatal`, or `silent` to disable). See
[docs/logging.md](docs/logging.md) for details.

## Build from source

climon ships as two binaries built from two toolchains:

- **Client (`climon`) — Rust.** The launcher/attach client, session host, PTY,
  `run`/`ls`/`kill`, `config`, `setup`, `update`, the remote bridge, and the
  installer are built from the Rust workspace under [`rust/`](rust/). **All
  client development happens here.**
- **Dashboard server (`climon-server`) — Bun.** The React + Fluent UI dashboard
  and its REST/SSE/WebSocket APIs are built from `src/server.ts`.

> The rest of the TypeScript under `src/` is the **legacy client**, frozen and
> kept only for the Bun test suite. Fix client bugs in the Rust crates, not
> there. See [docs/architecture.md](docs/architecture.md).

Requirements:

- A stable **Rust** toolchain (edition 2021) to build the client.
- [Bun](https://bun.sh) ≥ 1.3.0 (≥ 1.3.14 on Windows) to build/run the dashboard
  server.

```sh
cargo build --release --manifest-path rust/Cargo.toml   # build the Rust client
bun install                                             # server dependencies
bun run build:server                                    # build climon-server
```

To produce self-contained release archives (the same ones the installer
downloads):

```sh
bun run compile        # packages the host platform's dist/climon-<host>.zip
```

Each archive contains the Rust `install` binary, `climon-server`, and a
`climon-alpha` sentinel; running `install` self-installs `climon` and
`climon-server` side by side. See [docs/deployment.md](docs/deployment.md) for
the full release and signing pipeline.

## Documentation

- [docs/cheat-sheet.md](docs/cheat-sheet.md) — one-page command reference
- [docs/setup.md](docs/setup.md) — install locations and onboarding state
- [docs/usage.md](docs/usage.md) — detailed usage, config, and remote/WSL setup
- [docs/architecture.md](docs/architecture.md) — components and data flow
- [docs/security.md](docs/security.md) — threat model for remote features
- [docs/deployment.md](docs/deployment.md) — release, signing, and update trust
- [docs/logging.md](docs/logging.md) — logging and diagnostics
- [docs/troubleshooting.md](docs/troubleshooting.md) — common problems

## Contributing

Day-to-day work goes through the `dev` branch:

- **Open pull requests against `dev`, never `main`.** Pushing to `main` triggers
  the [Release](.github/workflows/release.yml) workflow, which bumps the version,
  tags, and publishes artifacts.
- **`dev` is merged into `main` only when you deliberately want to ship a
  release.**

Build and test the client with `cargo build` / `cargo test` / `cargo clippy` in
`rust/`; test the server and legacy suite with `bun test tests`. New features
ship with manual checks under [docs/manual-tests/](docs/manual-tests/).

## License

climon is open source under the [MIT License](LICENSE). Run `climon license` to
print the licence and third-party attributions.
