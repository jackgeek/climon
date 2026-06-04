# Usage

## Start the dashboard

```bash
climon server                 # http://127.0.0.1:3131 (localhost only)
climon server --port 8080     # custom port
climon server --lan           # bind 0.0.0.0; other machines need ?token=<token>
```

The server prints the URL on startup. With `--lan`, it also prints the access
token; append `?token=<token>` to the URL from other machines.

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
  `running`, `needs-attention`, `completed`, `failed`, or `disconnected`.
  Sessions are ordered `needs-attention` first, then `running`, then
  `completed`/`failed`. Hover over a row to reveal a close box (×) that cleans
  up the session — this removes it from the dashboard without ending a climon
  client still attached to it.
- **Terminal** (right): click a session to open it.
  - For **running** sessions, the terminal is live and interactive over a
    WebSocket — type to send input (e.g. answer a Copilot prompt to let it
    continue).
  - For **completed/failed** sessions, the terminal shows the captured final
    output (read-only).
- **View mode**: open the hamburger menu and toggle **Clamp size**. When checked,
  the browser and attached climon client stay on the same terminal grid. When
  unchecked, the browser terminal resizes the PTY to the available browser space.
  While the browser terminal is focused, **Ctrl-+** and **Ctrl--** change the
  terminal font size instead of zooming the browser. If an unclamped browser size
  makes the PTY too large for an attached climon client terminal, that local
  terminal shows a warning and the restore shortcut.
- The list updates automatically as sessions change state (via Server-Sent
  Events).
- When one or more sessions need attention, the browser tab title shows the
  count as `climon (!N)`. For newly attentive sessions after the dashboard loads,
  the page also attempts to play a short alert sound and show a browser
  notification while the dashboard remains open.

## Creating sessions from the dashboard

Session creation happens **from a session**. Hover any live session (`running`,
`needs-attention`, or `disconnected`) and click its **[+]** to launch a new
session from it. The server spawns the new session directly, inheriting the
originating session's working directory, so you are prompted only for the
command. This works from any live session, including ones that were themselves
spawned this way (arbitrary nesting).

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

Tune the idle window in `~/.climon/config.json` under `attention.idleSeconds`;
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

### `climon config`

`climon config` works like `git config`. It reads/writes a project-local or
global `.climon/config.json`:

- `climon config remote.tunnelId <id>` — set a value.
- `climon config remote.tunnelId` — print a value (exit 1 if unset).
- `climon config --list` — print all values.
- `climon config --debug` — print each candidate config file and the keys found
  in resolution order.
- `climon config --unset remote.tunnelId` — remove a value.
- `--global` (default) writes `~/.climon`; `--local` writes `./.climon`.

When climon reads a setting it checks `.climon/config.json` in the current
directory, then each ancestor, then `~/.climon/config.json`. When writing a
setting, if no `.climon` directory exists in the current directory or its
ancestors, climon creates one in `~/`.
