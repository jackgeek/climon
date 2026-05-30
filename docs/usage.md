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
existing session (via the `CLIMON_SESSION_ID` environment variable), runs the
command directly with inherited stdio, and exits with the command's exit code —
so the parent session keeps owning the PTY.

### Detach and reattach

While attached, press **Ctrl-\\** then **d** to detach. The command keeps running
in its daemon. Reattach later:

```bash
climon ls                 # find the session id
climon attach <id>        # reconnect your terminal
```

Detaching does **not** stop the command, and restarting `climon server` does not
affect running sessions.

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
- The list updates automatically as sessions change state (via Server-Sent
  Events).

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

Tune the idle window in `~/.climon/config.json` under `attention.idleSeconds`;
set it to `0` (or less) to disable static-screen detection. Detection runs only
while a local client is attached.

## Completion

When a command exits, its session moves up the queue (above plain `running`
sessions) and retains its final scrollback, so you can review what happened
without reattaching.
