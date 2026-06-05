# Usage

## Start the dashboard

```bash
climon server                 # http://127.0.0.1:3131 (localhost only)
climon server --port 8080     # custom port
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

This starts the command inside a managed PTY and attaches your terminal to it —
it behaves exactly like running the command directly. Meanwhile it appears on the
dashboard.

### Nested invocations

If you run `climon <cmd>` from a shell that is itself running inside a climon
session, climon does **not** start a second nested session. It detects the
existing session (via the `CLIMON_SESSION_ID` environment variable), prints an
error, and exits without running the nested command.

### Detach and reattach

While attached, press **Ctrl-\\** then **d** to detach. The command keeps running
in its daemon. Reattach later:

```bash
climon ls                 # find the session id
climon attach <id>        # reconnect your terminal
```

Detaching does **not** stop the command, and restarting `climon server` does not
affect running sessions.

If the dashboard is in Fill window mode and the browser grows the shared PTY
beyond your attached local terminal, press **Ctrl-\\** then **c** in the local
climon client to restore Clamp to remote terminal size mode.

## Manage sessions

```bash
climon ls                 # list sessions (attention-flagged first)
climon attach <id>        # reattach a running session
climon kill <id>          # terminate a session and remove its metadata
```

## The dashboard

- **Session list** (left): every monitored session with a status badge —
  `running`, `available`, `needs-attention`, `completed`, `paused`, `failed`,
  or `disconnected`. Sessions are ordered `needs-attention` first, then
  `available`, `running`, terminal outcomes, `paused`, `failed`, and
  `disconnected`. Hover over a row to reveal controls for editing, pausing or
  resuming, spawning a child session, and closing the session. Closing removes it
  from the dashboard without ending a climon client still attached to it unless
  you choose to kill the process.
- **Terminal** (right): click a session to open it.
  - For **running**, **available**, **needs-attention**, and **paused** sessions,
    the terminal is live and interactive over a WebSocket — type to send input
    (e.g. answer a Copilot prompt to let it continue). Pausing is dashboard-only:
    it keeps the PTY running but prevents live-state automation from changing the
    visible status until you resume.
  - For **completed/failed** sessions, the terminal shows the captured final
    output (read-only).
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
- The list updates automatically as sessions change state (via Server-Sent
  Events).
- When one or more sessions need attention, the browser tab title shows the
  count as `climon (!N)`. For newly attentive sessions after the dashboard loads,
  the page also attempts to play a short alert sound and show a browser
  notification while the dashboard remains open.

## Creating sessions from the dashboard

Session creation happens **from a session**. Hover any live session (`running`,
`available`, `needs-attention`, `paused`, or `disconnected`) and click its
**[+]** to launch a new session from it. The server spawns the new session
directly, inheriting the originating session's working directory, so you are
prompted only for the command. This works from any live session, including ones
that were themselves spawned this way (arbitrary nesting).

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

Browser notifications use the message title `climon needs attention` and name
the specific session in the body. Sound and browser notifications depend on the
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

1. On the machine running `climon server`, open the dashboard, click the
   hamburger menu, and choose **Remotes…**.
2. If the `devtunnel` CLI is installed on the server machine, let climon create
   and host the tunnel for you. Otherwise create a dev tunnel manually and paste
   its id or URL plus connect token into the dialog.
3. Optionally choose the default color and priority for that devbox's sessions,
   then copy the generated config script.
4. Run the script on the devbox. It records `remote.tunnelId`,
   `remote.tunnelToken`, `remote.port`, and any chosen session defaults with
   `climon config`.
5. Run any command on the devbox with `climon <cmd>`. The session appears on your
   dashboard under the devbox's stable client id.

Revoke a devbox by deleting or rotating the dev tunnel (or its connect token).

## Connecting Windows and WSL on the same machine

Windows and WSL can use the same remote ingest/uplink bridge without a dev
tunnel. Configure the dashboard side to bind its ingest daemon on an address the
other side can reach, then configure the session side to connect directly to
that address:

```bash
# Dashboard side: choose an address reachable from the other side.
climon config remote.ingestHost <dashboard-reachable-host>
climon config remote.port 3132

# Session side: point the uplink at the dashboard side.
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

# Copy the emitted token into the Remotes dialog.
devtunnel token climon-tunnel --scopes connect
```

Paste the tunnel id (or the printed `devtunnels.ms` URL) and the connect token
into **Remotes…**. climon will host the recorded tunnel if the `devtunnel` CLI is
available on the home machine; otherwise keep `devtunnel host climon-tunnel`
running yourself. Then copy the generated climon config script from the dialog
and run it on the devbox.

<!-- BEGIN GENERATED CONFIG SETTINGS -->
### `climon config`

`climon config` works like `git config`. It reads project-local config first, then ancestor directories, then the global config under `$CLIMON_HOME`.

- `climon config remote.tunnelId <id>` — set a value.
- `climon config remote.tunnelId` — print a value (exit 1 if unset).
- `climon config --list` — print all set user-facing values.
- `climon config --debug` — print each candidate config file and the keys found in resolution order.
- `climon config --unset remote.tunnelId` — remove a value.
- `climon config --help` — print this settings reference in the terminal.
- `--global` writes `$CLIMON_HOME/config.jsonc`; `--local` writes `./.climon/config.jsonc`.

climon writes `config.jsonc` so generated comments can explain each setting. Legacy `config.json` files are read for backward compatibility and migrated to `config.jsonc` on first write, leaving `config.json.bak` as a backup.

| Path | Type | Default | Scope | Description |
|------|------|---------|-------|-------------|
| `version` | number | `1` | client, daemon, server | Schema version for the persisted config.json format. Always 1 for the current release. (**internal**) |
| `server.host` | string | `127.0.0.1` | server | IP address the dashboard server binds to. Defaults to loopback for local-only access. |
| `server.port` | number | `3131` | server | TCP port the dashboard server listens on. Change if 3131 conflicts with another service. |
| `terminal.clampBrowserToHost` | boolean | `true` | daemon | When true (default), a browser viewer cannot grow the shared PTY beyond the host terminal's dimensions to prevent content mangling. |
| `terminal.detachPrefix` | number | `28` | client | Byte value of the detach key prefix (default 0x1c = Ctrl-\). Press prefix then 'd' to detach without stopping the command. Must be an integer in [0, 255]. |
| `terminal.setTitle` | boolean | `true` | client | When true (default), climon sets the attached local terminal's title to the session name and updates it live on rename. Disables the whole title feature when false. |
| `attention.idleSeconds` | number | `10` | daemon | Number of seconds the rendered terminal grid must remain unchanged before the session is flagged as needing attention. Set to 0 or negative to disable static-screen detection. |
| `remote.enabled` | boolean | unset | client | Enables remote uplink so the local devbox forwards session metadata and I/O to a remote dashboard over a dev tunnel or direct connection. |
| `remote.host` | string | unset | client | Direct remote uplink host for same-machine or LAN setups. Takes precedence over dev tunnel forwarding when set. |
| `remote.ingestHost` | string | unset | client | Host address where the dashboard-side ingest daemon should listen for incoming remote session connections. |
| `remote.tunnelId` | string | unset | client | Dev tunnel id (e.g. "happy-tree-abc123") used by `devtunnel connect` to forward local climon traffic to a remote dashboard. |
| `remote.tunnelToken` | string | unset | client | Stores the dev tunnel connect token scoped to this tunnel. Supplied via DEVTUNNEL_ACCESS_TOKEN environment variable. (**sensitive**) |
| `remote.port` | number | unset | client | Local port the devbox forwards and the ingest daemon listens on. Defaults to server.port if not explicitly set. |
| `remote.clientId` | string | unset | client | Stable, non-secret client namespace; auto-generated once on the devbox to uniquely identify this remote client. (**internal**) |
| `session.color` | string | `auto` | client, daemon, server | Specifies the default accent color for new sessions. Accepts ANSI color names (red, green, etc.), 'none', or 'auto' for automatic assignment. |
| `session.priority` | number | `500` | client, daemon, server | Default sort priority (0-1000) for new sessions. Lower numbers sort first within each status group. |
<!-- END GENERATED CONFIG SETTINGS -->
