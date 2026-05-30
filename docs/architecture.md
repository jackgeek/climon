# Architecture

climon is a built-in, cross-platform session manager. There are three roles: the
**launcher/client**, the per-session **daemon**, and the **dashboard server**.
They are decoupled through the filesystem (session metadata) and per-session
sockets.

```
climon <cmd>  ──spawn(detached)──►  session daemon  ──Bun.Terminal──►  user command
     │  (local attach client)            │  owns PTY + scrollback ring buffer
     │  raw-mode stdin/stdout            │  listens on per-session socket
     │  static-screen attention det.     │  (single writer of session metadata)
     └──────── IPC socket ───────────────┤  applies client attention frames
                                          │  writes ~/.climon/sessions/<id>.json
climon server (Bun.serve)                 │  persists final buffer + status on exit
     │  scans ~/.climon/sessions/*.json   │
     │  fs.watch → SSE status updates     │
     │  WS /api/sessions/:id/attach ──────┘  (bridges browser ⇆ daemon socket)
     └─ serves React + Fluent UI dashboard (bundled xterm.js, no iframe)
```

## Components

### PTY (`src/pty.ts`)

Wraps Bun's native pseudo-terminal API (`new Bun.Terminal(...)` +
`Bun.spawn(cmd, { terminal })`). Exposes a small `PtyHandle`:
`onData`, `onExit`, `write`, `resize`, `kill`, `pid`.

Early output and a fast exit are buffered inside `spawnPty` so a listener that
attaches a moment after spawn never misses data. (This was the root cause of an
early bug: node-pty under Bun closed the master fd prematurely and lost output —
replacing it with `Bun.Terminal` fixed it.)

### Session daemon (`src/daemon/daemon.ts`)

Launched as `climon __session <id>`, detached from the launcher. It:

1. Reads the session metadata file.
2. Spawns the PTY and **synchronously** attaches `onData`/`onExit`.
3. Patches metadata to `running` with its PID.
4. Listens on the per-session socket (`createServer`), replaying the scrollback
   buffer to each new client.
5. Appends PTY output to a ring buffer (`src/daemon/buffer.ts`, ~256 KB),
   broadcasts it to connected clients, and applies attention transitions
   reported by the attached client (it is the single writer of session
   metadata).
6. On PTY exit: persists final scrollback, patches metadata to
   `completed`/`failed` with the exit code, notifies clients, and shuts down.

Because the daemon owns the PTY, the dashboard server can come and go freely.

### IPC framing (`src/ipc/frame.ts`)

A length-prefixed binary protocol over the socket:
`[4-byte BE length][1-byte type][payload]`. Types: `Output`, `Input`, `Resize`,
`Exit`, `Replay`, `PtySize`, `Attention`. `FrameDecoder`
reassembles frames split across
chunks. `Resize` payloads carry a `source` (`host` for the local terminal,
`viewer` for a browser); the daemon clamps `viewer` resizes to the host
terminal's size (configurable, on by default) and broadcasts the resulting
`PtySize` so browsers render the same grid as the terminal. When the last
browser viewer disconnects, the daemon reverts the PTY to the host terminal's
size so a still-attached host terminal is not left rendering into a shrunken
grid.

### Local client (`src/client/connect.ts`)

Connects to the daemon socket, puts stdin in raw mode, forwards keystrokes as
`Input` frames, renders `Output`/`Replay` to stdout, sends `Resize` on terminal
resize, and detaches on **Ctrl-\ then d** without stopping the command.

### Launcher (`src/launcher.ts`)

`startMonitoredCommand` writes metadata, spawns the daemon (logging its output to
`~/.climon/sessions/<id>.log`), waits for the socket, prints the dashboard URL,
then attaches the local client. Also implements `attach`, `ls`, and `kill`.

### Dashboard server (`src/server/server.ts`)

A `Bun.serve` server, stateless with respect to PTYs:

- `GET /health` — unauthenticated `{ ok: true }` liveness probe.
- `GET /` — dashboard HTML shell that loads the React app bundle (localhost
  allowed; LAN requires a token).
- `GET /api/sessions` — current sessions, priority-sorted.
- `POST /api/sessions` — create a session (loopback only). With a `parentId`, the
  server spawns the new session itself, inheriting the parent's recorded working
  directory (and grid size); the parent only needs to be a live session, not
  attached to a local terminal. Without a `parentId`, the server spawns a session
  using the posted working directory. Either way it invokes the `climon` client
  binary (`src/cli/client-exec.ts`, looked up via `CLIMON_CLIENT_BIN` → sibling
  binary → dev source entrypoint → `PATH`).
- `DELETE /api/sessions/:id` — clean up a session, removing its metadata and
  scrollback. Does not signal the daemon, so an attached climon client keeps
  running.
- `GET /api/sessions/:id/scrollback` — final output for completed sessions.
- `GET /api/events` — Server-Sent Events; a debounced `fs.watch` on the sessions
  directory pushes updated lists.
- `WS /api/sessions/:id/attach` — bridges the browser WebSocket to the daemon
  socket, translating between the JSON browser protocol and the binary frame
  protocol.
- `GET /assets/app.js` — the bundled React + Fluent UI dashboard. In the compiled
  binary it is served from the base64-embedded copy; running from source it is
  built on demand with `Bun.build` (`src/server/web-build.ts`) and cached.
- `GET /assets/xterm.css` — xterm's stylesheet, embedded in the binary or resolved
  from `node_modules` via `Bun.resolveSync`.

The server is compiled from its own entrypoint (`src/server.ts`) into a separate
`climon-server` binary. The client entrypoint (`src/index.ts`) never imports server
code; its `server` subcommand resolves and execs `climon-server`
(`src/cli/server-exec.ts`, looked up via `CLIMON_SERVER_BIN` → sibling binary → dev
source entrypoint → `PATH`). This keeps the embedded dashboard bundle
(`src/server/embedded-assets.ts`) and the React/Fluent/`@xterm/*` dependencies out of
the client binary, so server-side growth never inflates the client.

### Dashboard UI (`src/web/`)

A React 19 single-page app styled with Fluent UI v9 (`@fluentui/react-components`),
mounted by `src/web/main.tsx` and bundled into `/assets/app.js`. It renders the
session list with status badges and an `xterm.js` terminal (`TerminalView`). Live
sessions (`running`/`needs-attention`) connect over the WebSocket; finished
sessions fetch and display their saved scrollback read-only. Each session row
has a close box (revealed on hover) that cleans up the session via
`DELETE /api/sessions/:id` without ending an attached climon client. Live
sessions (`running`/`needs-attention`/`disconnected`) show a per-session **[+]**
on hover that spawns a new session directly (server-side), inheriting that
session's recorded working directory — so you can launch a session from any live
session, including ones that were themselves spawned this way (arbitrary
nesting). When there are no sessions at all, a single header **[+]** offers the
same server-side creation. The HTML shell
and asset serving live in `src/server/assets.ts`.

## Data locations (`$CLIMON_HOME`, default `~/.climon`)

| Path | Purpose |
|------|---------|
| `config.json` | server host/port/lan/token, terminal clamp option |
| `sessions/<id>.json` | session metadata |
| `sessions/<id>.scrollback` | final captured output |
| `sessions/<id>.log` | daemon stdout/stderr (diagnostics) |
| `sock/<id>.sock` | per-session IPC socket (POSIX) |
| `\\.\pipe\climon-<id>` | per-session IPC pipe (Windows) |

## Priority ordering (`src/priority.ts`)

`needs-attention` < `running` < `completed`/`failed` < `disconnected`, ties
broken by most-recent update. This drives both the dashboard and `climon ls`.

## Attention detection (`src/client/idle-detector.ts`)

Detection is client-side and based on a static screen, not text patterns. While a
local client is attached it feeds every PTY output byte into a headless
`@xterm/headless` grid and, once per second, fingerprints the visible rows
(`translateToString` joined per row). The pure `ScreenIdleDetector` compares
successive fingerprints: if the screen stops changing for
`attention.idleSeconds` (default 10) the client sends a `FrameType.Attention`
frame to the daemon, which is the single writer that patches the session to
`needs-attention`; when the screen changes again it reverts to `running`.

Because only cell contents are fingerprinted (not the cursor position), a
blinking cursor is treated as static. Detection runs only while a local client is
attached, and setting `attention.idleSeconds` to `0` or less disables it.

## Remote clients (SSH uplink)

A devbox runs a singleton **uplink** agent (`climon __uplink`) that holds one
hardened SSH connection to the home machine. sshd runs a forced **accept
handler** (`climon-server --ssh-accept --label <label>`) for that key. Session
I/O is multiplexed over the single SSH stdio channel using a small framed
protocol (`src/remote/mux.ts`): control messages advertise session add/update/
remove and attach/detach; data messages carry opaque daemon frames.

The accept handler materializes each remote session as a **local** unix socket
plus a `~/.climon/sessions/<label>~<id>.json` metadata file (`origin: "remote"`).
The existing dashboard plumbing (fs.watch → SSE, browser WS ⇄ unix socket bridge)
then works unchanged — it cannot tell local and remote sessions apart except for
the origin tag. Attach is on demand: a browser connecting to the local socket
triggers an `attach` control to the devbox, which connects to the real daemon
socket (replaying scrollback) and bridges bytes back.
