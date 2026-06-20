# climon

A web-based monitor for interactive CLI sessions. Prefix any command with
`climon` to run it inside a managed pseudo-terminal; a local dashboard lists all
monitored sessions, surfaces the ones that need your attention, and lets you
interact with each one from the browser.

## Highlights

- **No runtime dependencies.** The Rust client uses a native PTY layer
  (`portable-pty`: openpty on Linux/macOS, ConPTY on Windows); the Bun dashboard
  server uses Bun's built-in HTTP/WebSocket server. Runs natively on Linux,
  macOS, and Windows.
- **Sessions survive server restarts.** Each command runs under its own detached
  per-session daemon that owns the PTY. Restarting `climon server` never kills a
  session.
- **Live web terminal.** The dashboard is a React + Fluent UI app that embeds an
  `xterm.js` terminal wired to the session over a WebSocket — fully interactive,
  no iframe.
- **Attention queue.** While a session is attached locally, climon mirrors its
  output into a headless terminal and watches the rendered screen. If the visible
  content stops changing for `attention.idleSeconds` (default 10) — a blinking
  cursor counts as static — the session is flagged and bumped to the top of the
  dashboard.
- **Completion pops.** Finished sessions move up the queue and keep their final
  scrollback so you can review the output.
- **Remote clients.** Monitor sessions running on another machine over Microsoft
  [dev tunnels](https://learn.microsoft.com/azure/developer/dev-tunnels/), or
  bridge Windows and WSL directly on the same machine without a dev tunnel. See
  [Windows/WSL same-machine bridge](#windowswsl-same-machine-bridge-no-dev-tunnel),
  [Remote clients (dev tunnels)](#remote-clients-dev-tunnels), and
  [docs/security.md](docs/security.md).

## Architecture at a glance

climon ships as two binaries:

- **Client (`climon`) — Rust.** The launcher/attach client, session host, PTY,
  `run`/`ls`/`kill`, `config`, `setup`, `update`, the remote
  `uplink`/`ingest`/`link` bridge, and the native installer are built from the
  Rust workspace under [`rust/`](rust/). **All client development happens here.**
- **Dashboard server (`climon-server`) — Bun.** The React + Fluent UI dashboard
  and its REST/SSE/WebSocket APIs are built from `src/server.ts` (`src/server/`,
  `src/web/`). This is still Bun and is actively maintained.

> The rest of the TypeScript under `src/` (the old client: `src/index.ts`,
> `src/launcher.ts`, `src/cli/`, `src/remote/`, `src/install/`, …) is the
> **legacy client**, frozen and kept only for the Bun test suite. Don't fix
> client bugs there — change the Rust crates instead. See
> [docs/architecture.md](docs/architecture.md).

## Requirements

- **Rust** toolchain (stable, edition 2021) to build the `climon` client from
  [`rust/`](rust/) — `cargo build --release`.
- [Bun](https://bun.sh) >= 1.3.0 on Linux/macOS, or >= 1.3.14 on Windows
  (native ConPTY support is required) to build/run the dashboard **server** and
  the legacy TypeScript test suite.

## Quick start

```bash
cargo build --release --manifest-path rust/Cargo.toml   # build the Rust `climon` client
bun run build:server         # build the Bun dashboard server (`climon-server`)
climon server                # terminal 1: start the dashboard
```

> `bun run build:all` / `bun link` still build and link the **legacy** TS client
> for the test suite, but the shipped `climon` client is the Rust binary above.

Then in a new terminal:

```bash
climon bash                  # run any command in a monitored session
```

Open http://127.0.0.1:3131 and click a session.

## Commands

### `climon <command> [args...]`

Run any command inside a monitored PTY session. Use this whenever you want to
launch a long-running or interactive process (a build, a REPL, a coding agent)
and be able to check on it later from the web dashboard without keeping the
terminal window open.

```bash
climon bash                  # monitor an interactive shell
climon copilot               # monitor a coding agent session
climon npm run dev           # monitor a dev server
```

You can also tag a session at launch with organizing metadata, placed **before**
the command:

```bash
climon --priority 100 --color red --name "dev server" npm run dev
```

- `--priority N` — an integer `0–1000` (default `500`) controlling sort order in
  the dashboard and `climon ls`; lower sorts to the top.
- `--color C` — one of `black`, `red`, `green`, `yellow`, `blue`, `magenta`,
  `cyan`, `white` (or `none`); shown as a colored accent on the session.
- `--name S` — a friendly label shown instead of the command. It is also used as
  the local terminal's title, and updates live if you rename the session from the
  dashboard. When omitted, climon adopts the terminal's current title if the
  terminal reports one; otherwise the name is left blank (the dashboard and
  `climon ls` then show the command). Disable all title behavior by setting
  `terminal.setTitle` to `false` in `~/.climon/config.json`.

All three can also be set or changed from the dashboard by clicking the **cog**
button on a session. Sessions spawned from another session (the **[+]** button)
inherit its priority and color.

### `climon server [--lan] [--port N]`

Start the web dashboard. This serves the UI at http://127.0.0.1:3131 and
connects to all running session daemons via WebSocket. Use this when you want to
view, interact with, or manage your monitored sessions from a browser.

- `--lan` — bind to `0.0.0.0` so other machines on the network can access the
  dashboard.
- `--port N` — use a custom port instead of the default `3131`.
- `--no-takeover` — never terminate (or prompt to terminate) an already-running
  dashboard server. Instead, start a second server on the next available port.
  Useful for tests and for running a throwaway dashboard without disrupting your
  main one.

Once the server is running you can also start new sessions directly from the
dashboard. Session creation is **per-session**: hover any live session
(`running`, `acknowledged`, `needs-attention`, `paused`, or `disconnected`) and
click its **[+]** button to launch a new session from it. The server spawns the
new session directly, inheriting the selected session's working directory, so you
are prompted only for the command. Because this no longer depends on an attached
terminal, you can launch a session from any live session — including ones that
were themselves spawned this way (arbitrary nesting). Hover a session row to
pause or resume its dashboard status; pausing does not suspend the underlying
process or terminal input.

When there are **no** sessions at all, a global **[+]** appears in the
sidebar header instead. It asks the dashboard server to spawn a session for you
(prompting for a command and optional working directory); the server does this by
invoking the `climon` client binary — looked up via `CLIMON_CLIENT_BIN`, then a
sibling binary next to `climon-server`, then your `PATH`. For security, all
creation only works from the machine running the server (loopback); remote/LAN
clients cannot create sessions.

The client and dashboard server ship as two binaries: a lean `climon` (client) and
`climon-server` (dashboard). The shipped `climon` client is a native **Rust** binary
(built from the `rust/` workspace); the `climon-server` dashboard is the **Bun** binary
built from `src/server.ts`. Running `climon server` locates and runs `climon-server`
— looked up via `CLIMON_SERVER_BIN`, then a sibling binary next to `climon`, then your
`PATH`. The dashboard is a React + Fluent UI single-page app (`src/web/`) bundled and
embedded into `climon-server`; keeping it out of `climon` means client-only usage stays
small as the server grows.

### `climon ls`

List all monitored sessions with their IDs, status, and the command that was
run. Use this to find the session ID you need for `attach` or `kill`, or to
quickly check which sessions are still running.

### `climon attach <id>`

Reattach your terminal to a running session. Use this when you want to interact
directly with a monitored process from the command line (instead of the web UI),
for example to type into a REPL or respond to a prompt.

Detach without stopping the command using: `Ctrl-\` then `d`.

### `climon kill <id>`

Terminate a monitored session and its underlying process. Use this to clean up
sessions you no longer need — finished builds, abandoned REPLs, or any process
you want to stop.

### `climon setup`

Re-run the first-run onboarding flow at any time: licence acceptance, telemetry
opt-in, and auto-update opt-in. Interactive by default; for non-interactive or
scripted setup, pass flags:

```bash
climon setup --apply --accept-eula --telemetry=off --auto-update=off
```

- `--apply` — run non-interactively (no prompts); apply the provided flags.
- `--accept-eula` — accept the licence (required for `--apply` to complete).
- `--telemetry=on|off` — set anonymous usage telemetry (default **off**).
- `--auto-update=on|off` — set background auto-update (default **off**).

Choices are stored in your global config and can also be changed directly, e.g.
`climon config telemetry.enabled false` or `climon config update.auto true`.

### `climon update`

Download, verify, and apply the latest released version. The downloaded
artifact's Ed25519 signature is verified against the embedded public key before
anything is replaced; tampered or unverifiable downloads are rejected with no
changes made.

Updates are **non-destructive**: `climon update` never kills running sessions or
a running dashboard server. It swaps binaries atomically (rename-over on Unix,
displace-to-`.old` on Windows) and defers when a file is locked. Already-running
processes keep using the old code; newly started sessions and a restarted server
pick up the new version.

When auto-update is off (the default), climon prints a one-line banner when a
newer version is available, suggesting you run `climon update`.

## Install & onboarding

On first run, climon walks you through a short onboarding flow:

1. **Licence acceptance** — climon is proprietary freeware governed by Irish
   law; the full text is in [`EULA.md`](EULA.md). You must accept to continue.
2. **Telemetry opt-in** — anonymous usage telemetry, **off by default**. When
   enabled, it is keyed only by a random install id and never includes session
   output, command contents, file paths, or hostnames.
3. **Auto-update opt-in** — background download/apply of signed updates, **off
   by default**. When off, climon only suggests updates via a banner.

Re-run onboarding anytime with `climon setup`. See [docs/setup.md](docs/setup.md)
for where state is stored and how to change choices later.

## Windows/WSL same-machine bridge (no dev tunnel)

The easiest setup is automatic: install climon on **Windows**, run `climon
server`, then run climon normally in **WSL**. The first WSL run detects the
Windows climon and auto-links discovery in both directions (it prints how to
disable this first), so WSL sessions show up on the Windows dashboard with no
config. Link manually any time with:

```bash
climon link                                          # auto-detect Windows CLIMON_HOME
climon link --peer-home /mnt/c/Users/<you>/.climon   # or specify it
```

Discovery reads beacons (local `server.json` first, then the peer at
`remote.peerHome`), validates the peer by TCP-probing its published `ingest.json`
host (not the dashboard `/health`, which is unreachable from WSL under default
NAT), and reads the live dashboard/ingest ports from the beacons — so a port bump
on collision just works. Switching which OS hosts is automatic: run `climon server`
on the other OS and it displaces the current host over the filesystem, migrating the
previous host's sessions via an uplink. Disable auto-linking with `climon config
remote.autoLink false`, and
override the peer host (if auto-detection picks the wrong one) with `climon
config remote.peerHost <host>`. See
[docs/usage.md](docs/usage.md#connecting-windows-and-wsl-on-the-same-machine).

### Manual bridge

You can still wire the ingest/uplink bridge by hand — the dashboard side runs
the ingest daemon; the client side runs an uplink that sends its local sessions
to that ingest port.

Use the same port on both sides. `3132` is the default ingest port, but setting
it explicitly makes the setup easier to inspect with `climon config --debug`.

### Server on Windows, client in WSL

Use this when `climon server` runs in PowerShell or another Windows terminal,
and WSL sessions should appear in that Windows dashboard.

> Note: with `remote.peerHome` linked, the ingest now **auto-binds** the
> `vEthernet (WSL)` address and publishes it in `ingest.json`, so the manual
> `remote.ingestHost` steps below are only needed to *override* the auto-resolved
> address.

1. In PowerShell, find the Windows address that WSL can reach:

   ```powershell
   Get-NetIPAddress -AddressFamily IPv4 |
     Where-Object InterfaceAlias -like 'vEthernet (WSL*' |
     Select-Object InterfaceAlias,IPAddress
   ```

2. On Windows, bind the ingest daemon to that WSL adapter address, then start the
   dashboard:

   ```powershell
   climon config remote.ingestHost <windows-wsl-adapter-ip>
   climon config remote.port 3132
   climon server
   ```

3. In WSL, point the uplink at the same Windows adapter address:

   ```bash
   climon config remote.enabled true
   climon config remote.host <windows-wsl-adapter-ip>
   climon config remote.port 3132
   climon bash
   ```

The WSL `climon bash` session should appear in the Windows dashboard. Prefer the
specific `vEthernet (WSL...)` address over `0.0.0.0`; direct mode trusts clients
that can reach `remote.ingestHost:remote.port`.

### Server in WSL, client on Windows

Use this when `climon server` runs inside WSL, and Windows sessions should appear
in that WSL dashboard.

1. In WSL, bind the ingest daemon to loopback and start the dashboard:

   ```bash
   climon config remote.ingestHost 127.0.0.1
   climon config remote.port 3132
   climon server
   ```

2. On Windows, point the uplink at WSL through Windows localhost forwarding:

   ```powershell
   climon config remote.enabled true
   climon config remote.host 127.0.0.1
   climon config remote.port 3132
   climon powershell
   ```

The Windows `climon powershell` session should appear in the WSL dashboard. If
localhost forwarding is disabled or another Windows process owns port `3132`,
use the WSL VM IP instead: bind `remote.ingestHost` to that WSL address and set
the Windows `remote.host` to the same address.

### Debugging Windows/WSL config

Run this on either side to see every config file climon considered, in resolution
order, and the keys found in each file:

```bash
climon config --debug
```

For direct Windows/WSL bridging, the client side must show
`remote.enabled`, `remote.host`, and `remote.port`. The server side should show
`remote.ingestHost` and `remote.port` when you use an explicit bind address.

### Switching which OS hosts the dashboard

You can run the dashboard from **either** WSL or Windows — one at a time — and
switch at will. With `remote.peerHome` configured on both sides (usually by
`climon link`), starting the dashboard on the other OS automatically takes over:

```bash
# On the OS that should now host the dashboard:
bun run server
```

It cleanly shuts down the dashboard still running on the other OS (its server,
ingest, and uplink), then **migrates** that OS's sessions over so they appear on
the new dashboard. The previous host's sessions reconnect automatically as long
as its ingest was still alive (the common case, including after a plain `Ctrl-C`
or a crash).

If a takeover cannot be confirmed, climon aborts and tells you which OS to run
`climon cleanup` on:

```bash
# Full local teardown of this machine's dashboard, ingest, and uplink:
climon cleanup
```

## Remote clients (dev tunnels)

Surface sessions running on a remote **devbox** in your local dashboard. The
transport is a Microsoft [dev tunnel](https://learn.microsoft.com/azure/developer/dev-tunnels/)
that exposes a loopback-only ingest port on the home machine; there is no SSH and
no network-exposed dashboard.

Setup:

1. Start a climon server locally and note its port (e.g. `climon server --port 8080`).
2. Open **Remotes…** from the dashboard's hamburger menu.
   - If the `devtunnel` CLI is installed on the home machine, climon can
     **auto-create** the tunnel for you (it also opens a keep-alive TCP port so
     the tunnel stays up and never shows a browser confirmation page).
   - Otherwise, create the tunnel manually and paste its id/URL into the dialog.
3. Optionally pick a default accent **color** and sort **priority** for that
   devbox's sessions, then **copy the config script**.
4. Run the copied script in a terminal on the **devbox**. It writes the server
   address/port (and optional color/priority) into the devbox's climon config.
5. Start sessions on the devbox as usual — they appear on the home dashboard.

Notes:

- The `devtunnel` CLI is required on **both** the home machine (to host the
  tunnel) and the devbox (to connect through it). Both sides must be logged in
  (`devtunnel user login`) with the same identity.
- **Restarting the webserver preserves sessions.** Local sessions are
  reconstructed from `~/.climon/sessions`, and the ingest daemon re-materializes
  remote sessions as devboxes reconnect, so a restart does not lose state.
- Configuration is read hierarchically: climon looks for the setting in
  `.climon/config.json` in the current directory, then walks up each parent
  directory, then falls back to `~/.climon/config.json`. This lets you set a
  per-repo default (e.g. always green, priority 20) and a different global
  default (e.g. red, priority 500). Writing a setting when no `.climon` directory
  exists creates one in `~/`.

See [docs/security.md](docs/security.md) for the full threat model.

### Install on mobile (PWA) + push notifications

When you open a Tunnel Link on a phone, the dashboard menu shows **Install as PWA**.
Installing adds climon to your home screen so it can deliver **push notifications when
a session needs attention** — even when the app is closed.

- Android (Chrome): tap **Install as PWA**, then **Install**.
- iPhone (Safari, iOS 16.4+): tap **Install as PWA** for instructions, then use
  **Share → Add to Home Screen**. Open climon from the new icon, then enable
  notifications from the menu.

The install is **temporary**: it only works while that Tunnel Link is up. When the
tunnel closes, the app shows a banner asking you to long-press the icon and choose
**Uninstall**.

### Manual dev tunnel creation

The dashboard's **Auto-create tunnel** button is the easiest path. If you want
to create the tunnel yourself (for example to choose the id or expiry), run these
commands on the **home** machine where `climon server` is listening:

```bash
devtunnel user login

# Choose a stable lowercase id; or omit the id argument and copy the generated id.
devtunnel create climon-tunnel
devtunnel port create climon-tunnel -p 8080
```

Paste `climon-tunnel` (or a devtunnels.ms URL for that tunnel) into
**Remotes…**. If the `devtunnel` CLI is available on the home machine,
climon will host the recorded tunnel for you; otherwise keep
`devtunnel host climon-tunnel` running yourself. After that, copy the generated
climon config script from the dialog and run it on the devbox. Ensure the devbox
is also logged in (`devtunnel user login`).

Official reference:
[Create and host a tunnel](https://learn.microsoft.com/azure/developer/dev-tunnels/get-started) and
[Dev tunnels CLI commands](https://learn.microsoft.com/azure/developer/dev-tunnels/cli-commands).

## Building standalone binaries

To produce self-contained executables that run without Bun or this repository:

```bash
bun install                  # ensure dependencies are present
bun run compile              # packages the host platform's zip
```

The shipped `climon` client is a native **Rust** binary. `bun run compile` builds
the host target's Rust client (`cargo build --release -p climon-cli`) and packages
`dist/climon-<host>.zip`. Building all five platform zips at once requires the
prebuilt Rust clients for each target staged under `dist/.rust-clients/<platform>/`
and `CLIMON_ASSEMBLE=1`; the release pipeline cross-compiles those clients on native
runners (`.github/workflows/release.yml`). The Bun `climon-server` dashboard is built
unchanged.

This outputs per-platform zip archives to `dist/`:

| File | Platform | Contents |
| --- | --- | --- |
| `climon-linux-x64.zip` | Linux x86_64 | `install` (Rust client), `climon-server`, `climon-beta`, `climon-alpha` |
| `climon-linux-arm64.zip` | Linux aarch64 | `install` (Rust client), `climon-server`, `climon-beta`, `climon-alpha` |
| `climon-darwin-x64.zip` | macOS Intel | `install` (Rust client), `climon-server`, `climon-beta`, `climon-alpha` |
| `climon-darwin-arm64.zip` | macOS Apple Silicon | `install` (Rust client), `climon-server`, `climon-beta`, `climon-alpha` |
| `climon-windows-x64.zip` | Windows x86_64 | `install.exe` (Rust client), `climon-server.exe`, `climon-beta`, `climon-alpha` |

Inside each zip the `install` binary is the Rust `climon` client. The `climon-alpha`
entry is a small **sentinel marker**: when `install` runs and finds `climon-alpha`
beside it, it runs the native Rust self-installer (copies itself to `climon`, places
`climon-server`/`climon-beta`, sets up PATH, writes `.version`, prints the changelog).
`climon-beta` is the in-process server bundle used only by the legacy Bun client.

Each binary is fully standalone — no Bun installation or `node_modules` needed.
Unzip the archive for your platform and run `install` (it self-installs `climon`
and `climon-server` side by side; the `climon` client locates `climon-server` as a
sibling). On Linux and macOS the extracted binaries keep their executable bit; on
Windows use `install.exe`.

## Releasing

The version lives in `package.json` and is the single source of truth: both
binaries and the dashboard read it via `src/version.ts`, so a bump flows
everywhere on the next build.

Bump it with the release script, which rewrites `package.json`, commits the
change, and creates a matching `vX.Y.Z` git tag:

```bash
bun run release            # patch bump (default): 0.1.0 -> 0.1.1
bun run release minor      # 0.1.0 -> 0.2.0
bun run release major      # 0.1.0 -> 1.0.0
```

The script refuses to run with a dirty working tree (so the release commit only
contains the bump) and does **not** push — finish with `git push --follow-tags`.

### Automatic bump on merge to `main`

The patch bump runs automatically in CI whenever `main` is updated — i.e. when a
pull request is merged. The [`Release`](.github/workflows/release.yml) workflow
checks out `main`, runs `bun run release`, and pushes the bump commit and tag
back to `main`.

Notes:

- Works for **every** merge style — merge commit, squash, or rebase — because it
  triggers on any push to `main`, not on a local Git hook.
- The release commit message starts with `chore(release):`, and the workflow
  skips those, so the bump it pushes never triggers another bump.
- The workflow pushes with `GITHUB_TOKEN`, which works because `main` is not a
  protected branch. If you later protect `main` against direct pushes, the bot
  token can only bypass it on **organization** repositories; on a user-owned
  repo you must supply an **admin-owned** PAT with `contents: write` as the
  `RELEASE_TOKEN` secret (the workflow prefers it when present).
- To cut a `minor`/`major` release instead, run `bun run release minor|major`
  locally and push with `git push --follow-tags`.

For signed, auto-updatable releases — generating the signing keypair, embedding
the public key, configuring the CI secret, and how the update trust chain works —
see [`docs/deployment.md`](docs/deployment.md).

## Logging

climon logs to `$CLIMON_HOME/logs/` using structured pino. Control verbosity with
`logging.level` in config or the `CLIMON_LOG_LEVEL` environment variable
(`trace`…`fatal`, or `silent` to disable). See **[docs/logging.md](docs/logging.md)**
for details, including how to turn logging on and off and the optional App
Insights sink. (This replaces the old `CLIMON_DEBUG` / `CLIMON_STATUS_DEBUG`
flags.)

## Further reading

See [`docs/cheat-sheet.md`](docs/cheat-sheet.md),
[`docs/setup.md`](docs/setup.md), [`docs/usage.md`](docs/usage.md),
[`docs/architecture.md`](docs/architecture.md),
[`docs/security.md`](docs/security.md),
[`docs/deployment.md`](docs/deployment.md),
[`docs/logging.md`](docs/logging.md), and
[`docs/troubleshooting.md`](docs/troubleshooting.md) for details.
