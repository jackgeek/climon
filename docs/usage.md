# Usage

## Install

Download the release zip for your platform, unzip it, and run the bundled
`install` binary (`install.exe` on Windows). It is the native Rust `climon`
client; when run from the unzipped folder it finds the `climon-alpha` sentinel
marker beside it and runs the **native self-installer** — it copies itself to
`climon`, places `climon-server`, updates your shell profile
or user PATH, writes the installed `.version`, and prints the changelog. After
that, `climon` and `climon server` are on your PATH. Commands below are identical
regardless of how climon was installed.

## Start the dashboard

```bash
climon server                 # http://127.0.0.1:3131 (localhost only)
climon server --port 8080     # custom port
climon server --no-takeover   # coexist with a running server on the next free port
```

The server prints the URL on startup and binds to loopback (`127.0.0.1`) only for
local-only access.

## Monitor a command

Prefix any command with `climon`:

```bash
climon copilot
climon npm run dev
climon bash
```

To monitor an interactive shell without naming a command, use `climon shell`:

```bash
climon shell
```

This launches your detected parent shell (PowerShell on Windows) in a managed
PTY. Running `climon` with no arguments prints the help text instead of starting
a shell.

This starts the command inside a managed PTY and attaches your terminal to it —
it behaves exactly like running the command directly. Meanwhile it appears on the
dashboard.

You can give the session its own dashboard terminal theme with `--theme`, naming
any dashboard theme by its display name:

```bash
climon --theme "Dracula" npm test
climon run --theme "Adventure Time" bash
```

The name is matched leniently — an unrecognised name simply falls back to the
dashboard default in the browser (no error). Omit `--theme` to inherit the
default set from the dashboard **Default theme** menu (`dashboard.theme`).

### Nested invocations

If you run `climon <cmd>` from a shell that is itself running inside a climon
session, climon **still starts the session** and runs your command. It detects
the nesting via the `CLIMON_NEST_LEVEL` environment variable (incremented for
each level) and prints a yellow `climon: nested session (depth N)` warning to
stderr so you're aware you're stacking sessions, but it does not block or exit.

### Terminal size while attached

If the dashboard is in Fill window mode and the browser grows the shared PTY
beyond your attached local terminal, press **Ctrl-\\** then **c** in the local
climon client to restore Clamp to remote terminal size mode.

## Manage sessions

```bash
climon ls                 # list sessions (attention-flagged first)
climon kill <id>          # terminate a session and remove its metadata
```

## Onboarding, telemetry, and updates

### `climon setup`

Re-run the first-run onboarding flow (telemetry, auto-update) at any time.
Interactive by default; use flags for non-interactive setup:

```bash
climon setup                                            # interactive prompts
climon setup --apply --telemetry=on --auto-update=off
```

- `--apply` — non-interactive; apply flags without prompting.
- `--telemetry=on|off` — anonymous usage telemetry (default **off**).
- `--auto-update=on|off` — background auto-update (default **off**).

You can also change these later with `climon config telemetry.enabled <bool>`
and `climon config update.auto <bool>`.

### `climon update`

Manually download, verify, and apply the latest release:

```bash
climon update
```

The artifact's Ed25519 detached signature is verified against the embedded
public key before any file is replaced; unverifiable or tampered downloads are
rejected and nothing changes. Updates are **non-destructive** — they never kill
running sessions or a running dashboard server. Binaries are swapped atomically
(rename-over on Unix, displace-to-`.old` on Windows) and deferred when locked.
Running processes keep the old code; newly started sessions and a restarted
server use the new version.

When `update.auto` is off (default), climon prints a one-line banner when a
newer version is available instead of applying it automatically.

## The dashboard

- **Session list** (left): every monitored session with a status badge —
  `running`, `acknowledged`, `needs-attention`, `completed`, `paused`, `failed`,
  or `disconnected`. Sessions are ordered `needs-attention` first, then
  `acknowledged`, `running`, terminal outcomes, `paused`, `failed`, and
  `disconnected`. Hover over a row to reveal controls for editing, pausing or
  resuming, spawning a child session, and closing the session. Closing removes it
  from the dashboard without ending a climon client still attached to it unless
  you choose to kill the process.
- **Terminal** (right): click a session to open it.
  - For **running**, **acknowledged**, **needs-attention**, and **paused** sessions,
    the terminal is live and interactive over a WebSocket — type to send input
    (e.g. answer a Copilot prompt to let it continue). Pausing is dashboard-only:
    it keeps the PTY running but prevents live-state automation from changing the
    visible status until you resume.
  - For **completed/failed** sessions, the terminal shows the captured final
    output (read-only).
  - On touch devices, scroll the terminal with a vertical one-finger swipe: it
    drives the same scrolling as a mouse wheel — moving through scrollback for
    normal output, or scrolling within apps that track the mouse. The swipe does
    not trigger the browser's pull-to-refresh while you are over the terminal.
- **View mode**: each session row shows a **lock icon** next to the pause button
  on the active session. A closed lock means **clamped** — the browser and the
  attached climon client stay on the same terminal grid. An open lock means
  **fill** — the browser terminal resizes the PTY to the available browser space.
  Click the lock to toggle. On a narrow (mobile) viewport the active session is
  forced to clamped and the lock is disabled; the previous mode is restored when
  you return to a wider viewport. While the browser terminal is focused,
  **Ctrl-+** and **Ctrl--** change the terminal font size instead of zooming the
  browser. If an unclamped browser size makes the PTY too large for an attached
  climon client terminal, that local terminal shows a warning and the restore
  shortcut.
  - On a maximized mobile session, swipe in from the right edge to open the
    terminal panel. Choose **Keyboard** for the special-key bar (Esc, Tab,
    arrows, F-keys, modifiers) or **Font size** to step the terminal font up or
    down with **A−**/**A+**. The chosen font size is remembered across reloads.
    Tap outside the panel to close it; swipe again to reopen the chooser.
- The list updates automatically as sessions change state (via Server-Sent
  Events).
- **Menu preferences (☰).** The hamburger menu has a **Default theme** submenu
  that sets the dashboard-wide default terminal theme (Default plus curated
  themes such as Dracula, Gruvbox Dark, Monokai, Solarized, and GitHub, grouped
  into Dark and Light and searchable). Every session that has no theme of its own
  inherits this default live. Picking a light theme also switches the dashboard
  chrome to the Fluent light base. The selected default and the mobile **Pin key
  bar** toggle are stored in `config.jsonc` (`dashboard.theme` and
  `dashboard.keyBarPinned`), so they persist across reloads and are shared across
  every browser and device — including remote Tunnel Link viewers. You can also
  set them from the CLI with `climon config dashboard.theme "<name>"` (a theme
  display name, e.g. `"Dracula"`) and `climon config dashboard.keyBarPinned <bool>`.
- **Per-session theme.** A session can override the default with its own theme,
  set from the **Edit Session** dialog (and chosen at creation in the **New
  Session** dialog) or from the CLI with `--theme` (see *Monitor a command*).
  Choose **Inherit default** in the dialog to clear the override and follow the
  default again. The dashboard chrome and terminal always follow the *active*
  session's effective theme.
- When one or more sessions need attention, the browser tab title shows the
  count as `climon (!N)`. For newly attentive sessions after the dashboard loads,
  the page also attempts to play a short alert sound and show a browser
  notification while the dashboard remains open.

## Creating sessions from the dashboard

Session creation happens **from a session**. Hover any live session (`running`,
`acknowledged`, `needs-attention`, `paused`, or `disconnected`) and click its
**[+]** to launch a new session from it. The server spawns the new session on
the **machine that session lives on**, inheriting the originating session's
working directory, so you are prompted only for the command. This works from any
live session, including ones that were themselves spawned this way (arbitrary
nesting).

The dialog includes a **Headless** checkbox (unchecked by default). Unchecked
(visible) opens a GUI terminal window on that machine attached to the new
session; checked (headless) runs it in the background with no window. Use the
`session.terminalProgram` config setting to override which terminal emulator a
visible spawn opens.

When the originating session lives on a **remote devbox**, the spawn runs on the
devbox itself. Enable this by setting `feature.remoteSpawn enabled` on the
dashboard host, then re-pasting the remotes-screen setup script on the devbox
(it now enables the flag and installs the shared `remote.spawnSecret` that signs
each spawn command). With the flag off, the per-session **[+]** on a remote
session performs no privileged action.

When there are no sessions at all, the sidebar header shows a single **[+]**
instead, which asks the server to create a session for you (prompting for a
command and optional working directory). Creation only works from the machine
running the server (loopback).

## Attention queue

While you have a session attached locally, climon watches its rendered screen. If
the visible terminal content stops changing for `attention.idleSeconds` (default
10) — for example a command paused at a prompt, where only a blinking cursor
remains — climon flags the session as `needs-attention` and bumps it to the top
of the dashboard. As soon as the screen changes again the session reverts to
`running`. Open it and type the response in the web terminal to unblock the
command.

Opening a flagged session in the dashboard marks it `acknowledged`: it stays in
that calmer state — and is not re-flagged — until the screen meaningfully
changes. A browser resize or refit alone does not count as a change, so simply
viewing a static screen will not bounce it back to `needs-attention`. Typing into
a session has the same effect: after you send input, climon will not raise
`needs-attention` again until the program emits genuinely new output that then
sits idle for the window. This keeps a command you started but that runs silently
(for example `sleep 30`) from being flagged while it works.

Browser notifications use the session's label as the message title and the
session's terminal title as the body. Sound and browser notifications depend on the
browser allowing notification permission and audio playback; the tab title count
still updates when those browser features are blocked.

Tune the idle window in `~/.climon/config.jsonc` under `attention.idleSeconds`;
set it to `0` (or less) to disable static-screen detection. Detection runs only
while a local client is attached.

## Completion

When a command exits, its session moves up the queue (above plain `running`
sessions) and retains its final scrollback, so you can review what happened
without reattaching.

## Connecting a remote client over dev tunnels

You can monitor sessions that run on another machine (a "devbox") from your local
dashboard. Traffic rides a Microsoft dev tunnel to a loopback-only ingest port — see
[security.md](./security.md) for the full threat model.

1. On the home machine, enable the ingest/uplink bridge, then start or restart
   the dashboard: `climon config feature.remotes enabled` followed by
   `climon server`.
2. Open the dashboard, click the hamburger menu, and choose **Remotes…**.
3. If the `devtunnel` CLI is installed on the server machine, let climon create
   and host the tunnel for you. Otherwise create a dev tunnel manually and paste
   its id or URL into the dialog.
4. Optionally choose the default color and priority for that devbox's sessions,
   then copy the generated config script.
5. Run the script on the devbox. It records `remote.tunnelId`,
   `remote.port`, and any chosen session defaults with
   `climon config`.
6. Run any command on the devbox with `climon <cmd>`. The session appears on your
   dashboard under the devbox's stable client id.

Revoke a devbox by deleting the dev tunnel or removing its identity from the
tunnel's access list.

### Seeing which remotes are connected (`climon remotes`)

`climon remotes` reports the live remote topology from the local status beacons
(`ingest-status.json` / `uplink-status.json` under `$CLIMON_HOME`):

```bash
climon remotes            # one-shot snapshot
climon remotes --watch    # live-refreshing view (clears + redraws)
climon remotes --json     # machine-readable; pipe to jq
```

The human output has two sections: the local **uplink** (when this machine is a
devbox, its connection target + state) and the **ingest** connections (each
remote host currently connected to this machine, with its friendly
hostname/OS, address, and session count). A leading `●` marks a healthy entry;
`○` marks a **stale** one. Staleness is derived live by the reader — an entry is
stale when the writing process is gone or there has been no recent
ping/heartbeat — so a crashed uplink or ingest shows as stale rather than
lingering as healthy. The same data drives the dashboard's **Remote hosts**
menu, updated live over SSE.

`--json` emits a stable shape (top-level `uplink`, `ingest`, and
`remotesEnabled`) suitable for `jq`. When neither `feature.remotes` nor
`feature.wslBridge` is enabled, the command prints a short hint that remotes are
disabled instead of an empty list.

## Connecting Windows and WSL on the same machine

Windows and WSL each keep their own `CLIMON_HOME`, but the two filesystems are
mutually visible, so climon discovers a dashboard running on the other OS by
reading its `server.json` beacon — no dev tunnel required.

### Quick setup (recommended)

1. On **Windows**, install climon and start the dashboard: `climon server`.
2. In **WSL**, run `climon link` and answer **yes** to enable the WSL bridge (or
   use `climon link --wsl-bridge` in automation). This records
   `remote.peerHome` and `feature.wslBridge enabled` in **both** configs.
3. Restart the dashboard or start your next session. WSL sessions now appear on
   the Windows dashboard.

If you skip the explicit link step, the first WSL run still detects the Windows
climon and auto-links discovery in both directions, but it leaves
`feature.wslBridge` disabled. That lets each OS discover the other without
streaming sessions until you opt in.

The auto-link prints how to opt out before it writes anything:

```text
climon: detected a Windows climon at /mnt/c/Users/<you>/.climon; attempting to auto-link so sessions appear on the Windows dashboard.
climon: to prevent this, run: climon config remote.autoLink false
climon: auto-link successful — WSL<->Windows discovery configured on both sides. The WSL bridge is NOT enabled; turn it on with: climon config feature.wslBridge enabled (or run: climon link --wsl-bridge).
```

To link manually (or to re-link), run `climon link`:

```bash
climon link                                   # auto-detect, then prompt
climon link --wsl-bridge                      # enable without prompting
climon link --no-wsl-bridge                   # discovery only
climon link --peer-home /mnt/c/Users/<you>/.climon   # or specify it explicitly
```

`climon link` writes `remote.peerHome` on the WSL side and the reverse pointer
(`\\wsl.localhost\<distro>\home\<you>\.climon`) into the Windows config, so both
`WSL -> Windows` and `Windows -> WSL` discovery work from one command. It only
writes `feature.wslBridge enabled` when you accept the TTY prompt or pass
`--wsl-bridge`; with non-TTY stdin and no explicit flag, the bridge stays off.

How discovery resolves a dashboard, for any `climon` invocation:

1. The local `CLIMON_HOME/server.json` (validated by process liveness) — a
   dashboard on this OS.
2. Otherwise the peer at `remote.peerHome`, validated by reading its `ingest.json`
   beacon and TCP-probing the published ingest host (the dashboard `/health` is
   not used — under default WSL2 NAT a Windows-hosted dashboard binds loopback and
   is unreachable from WSL). The dashboard and ingest **ports are read live from the
   beacons**, so an automatic port bump on a collision is handled transparently.

The reachable host is auto-detected (`localhost`, or the WSL gateway IP under
NAT networking). Override it with `climon config remote.peerHost <host>` if
needed.

### Manual bridge (advanced)

If you prefer to wire the ingest/uplink bridge by hand (for example to bind the
ingest daemon to a specific non-loopback address), configure it directly:

```bash
# Dashboard side: choose an address reachable from the other side.
climon config feature.wslBridge enabled
climon config remote.ingestHost <dashboard-reachable-host>
climon config remote.port 3132

# Session side: point the uplink at the dashboard side.
climon config feature.wslBridge enabled
climon config remote.enabled true
climon config remote.host <dashboard-reachable-host>
climon config remote.port 3132
```

For WSL sessions shown in a Windows dashboard, `<dashboard-reachable-host>` is
usually the Windows WSL adapter address, visible in PowerShell with
`Get-NetIPAddress -AddressFamily IPv4`. Prefer the specific `vEthernet (WSL...)`
address over `0.0.0.0`. For Windows sessions shown in a WSL dashboard, Windows
can usually reach WSL services via `127.0.0.1` when WSL localhost forwarding is
enabled.

### Creating the dev tunnel manually

Use this path if you do not want the Remotes dialog to create the tunnel for you.
Run these commands on the **home** machine where the dashboard is listening:

```bash
devtunnel user login

# Use any valid lowercase tunnel id, or omit the id argument and copy the generated id.
devtunnel create climon-tunnel
devtunnel port create climon-tunnel -p 8080
```

Paste the tunnel id (or the printed `devtunnels.ms` URL) into **Remotes…**.
climon will host the recorded tunnel if the `devtunnel` CLI is available on the
home machine; otherwise keep `devtunnel host climon-tunnel` running yourself.
Then copy the generated climon config script from the dialog and run it on the
devbox. Ensure the devbox is also logged in (`devtunnel user login`).

### Feature flags

Major features can be gated behind feature flags stored under the `feature.` prefix in `config.jsonc` (for example `feature.sessionSpawning`). Each flag accepts `"enabled"` or `"disabled"`; any other value is treated as disabled.

```
climon config feature.sessionSpawning enabled
climon config feature.sessionSpawning disabled
```

Remote ingest startup is config-driven: set `feature.remotes enabled` before
using dev-tunnel remotes, or `feature.wslBridge enabled` before using the
Windows/WSL bridge. Enabling `feature.remotes` starts the ingest daemon for
devboxes but does not activate same-machine Windows/WSL uplinks or dashboard
handoff; those are gated independently by `feature.wslBridge`.

Every flag carries a maturity status — `experimental`, `incomplete`, `untested`, `known-issues`, or `ready`. Only `ready` features are considered safe; enabling a feature with any other status prints a warning. Some flags may be locked to a value by the application build, in which case your configured value has no effect until that build-level override is removed.

<!-- BEGIN GENERATED CONFIG SETTINGS -->
### `climon config`

`climon config` works like `git config`. It reads project-local config first, then ancestor directories, then the global config under `$CLIMON_HOME`.

- `climon config remote.tunnelId <id>` — set a value.
- `climon config remote.tunnelId` — print a value (exit 1 if unset).
- `climon config --list` — print all set user-facing values.
- `climon config --debug` — print each candidate config file and the keys and values found in resolution order; sensitive and unknown values are redacted.
- `climon config --unset remote.tunnelId` — remove a value.
- `climon config --help` — print this settings reference in the terminal.
- `--global` writes `$CLIMON_HOME/config.jsonc`; `--local` writes `./.climon/config.jsonc`.

climon writes `config.jsonc` so generated comments can explain each setting. Legacy `config.json` files are read for backward compatibility and migrated to `config.jsonc` on first write, leaving `config.json.bak` as a backup.

| Path | Type | Default | Scope | Description |
|------|------|---------|-------|-------------|
| `version` | number | `1` | client, daemon, server | Schema version for the persisted config file format. Always 1 for the current release. (**internal**) |
| `server.host` | string | `127.0.0.1` | server | IP address the dashboard server binds to. Defaults to loopback for local-only access. |
| `server.port` | number | `3131` | server | TCP port the dashboard server listens on. Change if 3131 conflicts with another service. |
| `terminal.clampBrowserToHost` | boolean | `false` | daemon | When false (default), a browser viewer may grow the shared PTY beyond the host terminal's dimensions. Set true to clamp viewer size to the host terminal to prevent content mangling. |
| `terminal.detachPrefix` | number | `28` | client | Byte value of the detach key prefix (default 0x1c = Ctrl-\). Press prefix then 'd' to detach without stopping the command. Must be an integer in [0, 255]. |
| `hotKeys.focusTopSession` | string | `Alt+J` | server, browser | Web dashboard shortcut that selects the top session in the list and focuses its terminal. Format is "Mod+...+Key" (e.g. "Alt+T", "Ctrl+Shift+J"). Set to an empty string to disable. |
| `dashboard.theme` | string | `Default` | server, browser | Default web dashboard terminal colour theme (by display name, e.g. "Dracula"). Sessions without their own theme inherit this. Choose from the dashboard "Default theme" picker; defaults to "Default". |
| `dashboard.keyBarPinned` | boolean | `true` | server, browser | Whether the web dashboard key bar is pinned open. |
| `attention.idleSeconds` | number | `10` | daemon | Number of seconds the rendered terminal grid must remain unchanged before the session is flagged as needing attention. Set to 0 or negative to disable static-screen detection. |
| `notifications.smartSnippet` | boolean | `true` | daemon | When true (default), attention notifications include a fuzzy-extracted snippet of the last relevant terminal output as the notification body. Set false to send only the session name / terminal title. |
| `remote.enabled` | boolean | unset | client | Enables remote uplink so the local devbox forwards session metadata and I/O to a remote dashboard over a dev tunnel or direct connection. |
| `remote.host` | string | unset | client | Direct remote uplink host for same-machine or LAN setups. Takes precedence over dev tunnel forwarding when set. |
| `remote.ingestHost` | string | unset | client | Host address where the dashboard-side ingest daemon should listen for incoming remote session connections. |
| `remote.tunnelId` | string | unset | client | Dev tunnel id (e.g. "happy-tree-abc123") used by `devtunnel connect` to forward local climon traffic to a remote dashboard. |
| `remote.dashboardTunnelId` | string | unset | server | Server-owned persisted dashboard tunnel id used to reuse tunnel identity for tunnel link sessions. (**internal**) |
| `remote.dashboardTunnelCluster` | string | unset | server | Server-owned persisted dashboard tunnel cluster used to reuse tunnel identity for tunnel link sessions. (**internal**) |
| `remote.dashboardTunnelEnabled` | boolean | unset | server | Server-owned flag recording whether the Tunnel Link is enabled, so the server re-establishes the dashboard tunnel automatically on startup. (**internal**) |
| `remote.port` | number | unset | client | Local port the devbox forwards and the ingest daemon listens on. Defaults to server.port if not explicitly set. |
| `remote.ingestPortRetryAttempts` | number | `100` | server | How many consecutive ports the ingest daemon will try, starting at its preferred port, before giving up. Raise it if many ports near the default are already in use. |
| `remote.clientId` | string | unset | client | Stable, non-secret client namespace identifying this machine's sessions. Defaults to the machine hostname when unset; set it to a value that is unique per host to avoid session ID collisions across machines. |
| `remote.spawnSecret` | string | unset | client, server | Shared HMAC secret authenticating dashboard→devbox spawn commands. Generated automatically on the dashboard host when feature.remoteSpawn is enabled, and planted on the devbox by the remotes-screen setup script. Keep it secret. (**sensitive**) |
| `remote.keepAlive` | number | `60` | client | Interval in seconds between mux keepalive pings sent over the remote uplink/ingest connection. Prevents dev tunnel idle timeouts from dropping the connection. Set to 0 to disable. |
| `remote.peerHome` | string | unset | client, server | Path to the peer OS's CLIMON_HOME for same-machine WSL<->Windows discovery (e.g. /mnt/c/Users/<you>/.climon from WSL, or \\wsl.localhost\<distro>\home\<you>\.climon from Windows). When feature.wslBridge is enabled, climon reads the peer's beacons and wires sessions to it. Usually set automatically by `climon link`. |
| `remote.peerHost` | string | unset | client, server | Optional host override used to reach the peer dashboard/ingest. Leave unset to auto-detect (localhost, or the WSL gateway IP under NAT networking). |
| `remote.autoLink` | boolean | `true` | client | When true (default), the first `climon` run inside WSL attempts to auto-link to a Windows-side climon by detecting its CLIMON_HOME and setting remote.peerHome on both sides. Auto-link configures discovery only; it never enables feature.wslBridge. Set false to disable auto-linking. |
| `session.color` | string | `auto` | client, daemon, server | Specifies the default accent color for new sessions. Accepts ANSI color names (red, green, etc.), 'none', or 'auto' for automatic assignment. |
| `session.priority` | number | `500` | client, daemon, server | Default sort priority (0-1000) for new sessions. Lower numbers sort first within each status group. |
| `session.terminalProgram` | string | unset | client | Command template used to open a terminal window for a non-headless (visible) session spawned from the dashboard. Use the {cmd} placeholder for the climon command to run. When unset, climon auto-detects a terminal per OS (Terminal.app, Windows Terminal, or x-terminal-emulator/gnome-terminal/konsole/xterm). |
| `tunnelLink.keepAlive` | number | `60` | server | Interval in seconds between keep-alive pings sent through the Tunnel Link dev tunnel relay to prevent idle disconnection. Set to 0 to disable keep-alive pings. |
| `logging.level` | string | `trace` | client, daemon, server | Minimum log level emitted by climon processes. One of: trace, debug, info, warn, error, fatal, silent. Defaults to trace (everything). Set to silent to disable logging. Overridden per-invocation by the CLIMON_LOG_LEVEL environment variable. |
| `feature.sessionSpawning` | string | `disabled` | client, daemon, server, browser | Allow spawning new sessions from the dashboard. Set to "enabled" or "disabled". [status: experimental] |
| `feature.remoteSpawn` | string | `disabled` | client, daemon, server, browser | Allow the dashboard to spawn sessions on remote devboxes over a signed, replay-protected mux command channel. Set to "enabled" or "disabled". [status: experimental] |
| `feature.wslBridge` | string | `disabled` | client, daemon, server, browser | Stream sessions between a same-machine WSL distro and Windows so they appear on one shared dashboard. Set to "enabled" or "disabled". [status: experimental] |
| `feature.remotes` | string | `disabled` | client, daemon, server, browser | Connect sessions from a remote devbox to this dashboard over the ingest/uplink bridge. Set to "enabled" or "disabled". [status: experimental] |
| `telemetry.enabled` | boolean | `false` | client, server | When true, climon sends anonymous, opt-in usage telemetry keyed only by a random install id (no PII, session output, commands, paths, or hostnames). Off by default. |
| `update.auto` | boolean | `false` | client | When true, climon downloads and applies signed updates automatically in the background. When false (default), it only prints a one-line banner suggesting `climon --update`. |
| `update.lastCheck` | string | unset | client | ISO-8601 timestamp of the last background update check. Used to throttle checks. (**internal**) |
| `update.availableVersion` | string | unset | client | Latest version discovered by the background update check, if newer than the installed version. Cleared after a successful update. (**internal**) |
| `license.noticeShown` | boolean | unset | client | Whether the one-time MIT license-change notice has been shown. Set automatically the first time an install that upgraded from a pre-open-source (EULA-gated) build launches; never shown on fresh installs. (**internal**) |
| `install.id` | string | unset | client, server | Anonymous, randomly generated install identifier used only when telemetry is enabled. Contains no personal information. (**internal**) |
<!-- END GENERATED CONFIG SETTINGS -->
