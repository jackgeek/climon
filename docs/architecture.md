# Architecture

climon is a built-in, cross-platform session manager. There are three roles: the
**launcher/client**, the per-session **daemon**, and the **dashboard server**.
They are decoupled through the filesystem (session metadata) and per-session
sockets.

> **Client = Rust, server = Bun.** The shipped
> `climon` *client* (launcher, attach client, `run`/`shell`/`ls`/`kill`,
> `config`, `setup`, `update`, remote `uplink`/`ingest`/`link`/`cleanup`, and the
> native self-installer) is the Rust binary built from the `rust/` workspace
> (crates `climon-cli`, `climon-session`, `climon-store`, `climon-config`,
> `climon-logging`, `climon-pty`, `climon-proto`, `climon-remote`,
> `climon-install`, `climon-update`). The **dashboard server** (`climon-server`)
> is the Bun binary built from `src/server.ts` with `src/server/` and `src/web/`;
> it is maintained alongside the Rust client. The old Bun/TypeScript client
> source tree has been removed. The remaining TypeScript under `src/` is the
> dashboard server/web plus shared support modules such as configuration,
> logging, i18n, selected remote ingest helpers, session defaults, and
> `src/update/pubkey.ts` (the Ed25519 public-key source read by the Rust update
> crate at build time). **All client work (features and bug fixes) happens in
> the Rust crates.**

```
climon <cmd>  ──spawn(detached)──►  session daemon  ──portable-pty──►  user command
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

### PTY (`rust/climon-pty/`)

Wraps the cross-platform native pseudo-terminal layer used by the Rust client
and session host (`portable-pty`: openpty on Linux/macOS, ConPTY on Windows).
It exposes the small handle the rest of the client needs: data, exit, input,
resize, kill, and process id.

Early output and a fast exit are buffered so a listener that attaches a moment
after spawn never misses data. On Windows, the PTY backend uses ConPTY and skips
Unix-only session-group handling.

### Session daemon (`rust/climon-session/`)

Launched as `climon __session <id>`, detached from the launcher. It:

1. Reads the session metadata file.
2. Spawns the PTY and **synchronously** attaches `onData`/`onExit`.
3. Patches metadata to `running` with its PID.
4. Listens on the per-session socket (`createServer`), replaying the scrollback
   buffer to each new client.
5. Appends PTY output to a ring buffer (~256 KB),
   broadcasts it to connected clients, and applies attention transitions
   reported by the attached client (it is the single writer of session
   metadata).
6. Scans PTY output for terminal titles (`OSC 0`/`OSC 2`) and progress
   (`OSC 9;4`, the ConEmu/Windows-Terminal taskbar-progress sequence),
   debounces them, and persists the latest `terminalTitle`/`progress` to
   metadata. Both are passthrough — the bytes are forwarded to the client
   untouched. The dashboard renders `progress` per session (a determinate bar,
   spinner, or error/warning icon).
7. On PTY exit: persists final scrollback, patches metadata to
   `completed`/`failed` with the exit code, notifies clients, and shuts down.

Because the daemon owns the PTY, the dashboard server can come and go freely.

### IPC framing (`rust/climon-proto/`)

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

### Local client (`rust/climon-cli/src/client.rs`)

Connects to the daemon socket, puts stdin in raw mode, forwards keystrokes as
`Input` frames, renders `Output`/`Replay` to stdout, sends `Resize` on terminal
resize, and detaches on **Ctrl-\ then d** without stopping the command.

### Launcher (`rust/climon-cli` launcher module)

`startMonitoredCommand` writes metadata, spawns the daemon (logging its output to
`~/.climon/sessions/<id>.log`), waits for the socket, prints the dashboard URL,
then attaches the local client. Also implements `attach`, `ls`, and `kill`.

### Dashboard server (`src/server/server.ts`)

A `Bun.serve` server, stateless with respect to PTYs:

- `GET /health` — unauthenticated liveness probe returning
  `{ ok: true, version, remotesEnabled, ports }`. `ports` lists every TCP port
  this server process has opened: `ports.dashboard` (always) and `ports.ingest`
  (only while the remote ingest daemon is running). Ingest startup is driven by
  config: the server starts it when either `feature.remotes` or
  `feature.wslBridge` is enabled, never by a server CLI flag.
- `GET /` — dashboard HTML shell that loads the React app bundle (served to any
  client that can reach the bound address; session creation and other privileged
  APIs are loopback-only).
- `GET /api/sessions` — current sessions, priority-sorted.
- `POST /api/sessions` — create a session (loopback only). With a `parentId`, the
  server spawns the new session on the machine that session lives on, inheriting
  the parent's recorded working directory (and grid size); the parent only needs
  to be a live session, not attached to a local terminal. Without a `parentId`,
  the server spawns a session using the posted working directory. Either way it
  invokes the Rust client's `climon __spawn` command (one source of truth for
  per-OS terminal launching; binary looked up via `CLIMON_CLIENT_BIN` → sibling
  binary → dev-built Rust binary → `PATH`). The request body's `headless` flag
  selects the mode: headless spawns return `201` with the new session id, while a
  visible spawn opens a GUI terminal window on that machine and returns `202` (the
  session appears via the metadata watch). This replaces the older in-process
  `spawn-session.ts` path. **Routing is by the parent's `origin`:** a *local*
  parent runs `climon __spawn` on the server host; a *remote* parent (origin
  `remote`, living on a devbox) is gated by `feature.remoteSpawn` and routed over
  a loopback-only control socket to this host's ingest, which signs a `Spawn`
  (HMAC-SHA256) and forwards it over the mux to the devbox uplink. The uplink runs
  `climon __spawn` on the devbox and replies with a signed `SpawnResult`; the
  server returns `201 {id: "<clientId>~<innerId>"}` on success, `202` on timeout
  or a visible spawn, or `502` on a devbox error. See [`security.md`](security.md)
  for the signed command channel. The ingest advertises its control socket as the
  `controlSocket` field in `ingest.json`.
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

There is no Bun client bundle anymore. Bundle separation is now enforced by the
Rust/Bun binary split: the Rust `climon` client never embeds React, Fluent UI,
`@xterm/*`, or the dashboard asset bundle, while the Bun `climon-server` binary
owns and embeds the web UI (`src/server/embedded-assets.ts`). Server-side growth
therefore never inflates the client. The server ships as a single compiled
binary, and a release zip contains it:

- **Compiled `climon-server` binary** — `src/server.ts` compiled with
  `bun build --compile` (per target in `scripts/compile.ts`) and installed alongside
  `climon`. This is the **canonical and only** server path: the shipped Rust client
  always spawns this binary (it cannot load a JS bundle in-process). The client's
  `server` subcommand resolves and spawns it via
  `rust/climon-cli/src/server_exec.rs` (`CLIMON_SERVER_BIN` → sibling
  `climon-server[.exe]` → dev source entrypoint → `PATH`).

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

## Onboarding, telemetry, and updates

Rust client crates implement first-run onboarding and secure, non-destructive
self-updates:

- **`rust/climon-cli`** — `climon setup`, telemetry/auto-update onboarding,
  server delegation, launch hooks, and CLI entrypoints.
- **`rust/climon-install`** — native self-install from release archives. A
  release zip's `install`/`install.exe` is the Rust client, and the tiny
  `climon-alpha` sentinel marker triggers the native self-install when the
  client runs beside it.
- **`rust/climon-update`** — manifest fetch, update-state throttling,
  downloads, detached-signature verification, atomic non-destructive binary
  swap, background checks, and the `climon update` command. Its build script
  reads `src/update/pubkey.ts`, which remains the shared Ed25519 public-key
  source of truth for the Bun release tooling and Rust updater.

**Data flow.** Installer/onboarding writes config state (`telemetry.enabled`,
`update.auto`, `install.id`). On `shell`/`run` launches,
launch hooks show a banner from the cached `update.availableVersion` and spawn a
throttled background check that refreshes that cache (and, when `update.auto` is
on, applies the update). `climon update` resolves the manifest, downloads the
artifact + detached signature, verifies the signature against the embedded
public key, and only then performs the atomic swap — never killing running
processes. Signing tooling lives in `scripts/gen-update-keys.ts` and
`scripts/sign-release.ts`, wired into `.github/workflows/release.yml`.

## Data locations (`$CLIMON_HOME`, default `~/.climon`)

| Path | Purpose |
|------|---------|
| `config.jsonc` | server host/port, terminal/theme/attention settings, feature flags (legacy `config.json` is read and migrated) |
| `server.json` | running dashboard server state: `{ pid, port, ingest? }` (discovery/stop; read by a peer OS for WSL<->Windows discovery) |
| `sessions/<id>.json` | session metadata |
| `sessions/<id>.scrollback` | final captured output |
| `sessions/<id>.log` | daemon raw stdout/stderr (uncaught crash output) |
| `logs/<role>/*.log` | structured pino NDJSON logs per role (server/client/daemon/ingest/uplink) |
| `sock/<id>.sock` | per-session IPC socket (POSIX) |
| `\\.\pipe\climon-<id>` | per-session IPC pipe (Windows) |
| `push/vapid.json` | server VAPID keypair for Web Push (auto-created) |
| `push/subscriptions.json` | browser push subscriptions (deduped by endpoint) |

## Logging (`rust/climon-logging/` and `src/logging/`)

The Rust client/session processes and the Bun dashboard server both write
structured NDJSON logs under `$CLIMON_HOME/logs/<role>/`, using equivalent
redaction and level semantics. The Rust side uses `rust/climon-logging`; the Bun
server keeps its maintained logging helpers in `src/logging/`, including the
server-only optional App Insights sink. Client terminal output is suspended while
attached to a PTY so logs never corrupt the shell. The per-session daemon also
keeps a separate raw `sessions/<id>.log` for uncaught crash traces. At level
`silent` no streams, directories, or files are created.

## Priority ordering (`src/priority.ts`)

`needs-attention` < `running` < `completed`/`failed` < `disconnected`, ties
broken by most-recent update. This drives both the dashboard and `climon ls`.

## Attention detection (`rust/climon-session/`)

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

When the daemon transitions a session to `needs-attention`, it also extracts a
fuzzy "smart snippet" of the last relevant terminal output from its live
`HeadlessGrid` (`rust/climon-session/src/snippet.rs`). The pure extractor runs
a deterministic heuristic: it reads the visible lines, filters noise (borders,
spinners, progress bars), and captures the last meaningful paragraph (capped at
160 chars). The daemon writes this as `attentionSnippet` in the same metadata
patch that flags `needs-attention`. The dashboard server then composes the
notification title and body from a shared helper (`src/notification-content.ts`):
title = session name → terminal title → command; body = snippet → terminal title
(if not promoted to title) → "". This is gated by the `notifications.smartSnippet`
config setting (boolean, default true, scope daemon).

## Web Push pipeline (mobile PWA)

The dashboard server (`climon-server`) gains an additive, fail-safe push pipeline
under `src/server/push/`:

- `vapid.ts` loads-or-creates a VAPID keypair at `$CLIMON_HOME/push/vapid.json`.
  The JWT `sub` claim defaults to a valid non-localhost `mailto:` (Apple rejects a
  `localhost` subject with `BadJwtToken`) and can be overridden with a real contact
  via `CLIMON_VAPID_SUBJECT`.
- `subscriptions.ts` persists browser push subscriptions atomically at
  `$CLIMON_HOME/push/subscriptions.json` (deduped by endpoint).
- `attention.ts` is a pure tracker that flags sessions newly entering
  `needs-attention` (seed-then-detect, deduped by `id:attentionMatchedAt`), and
  `buildPushPayload` sets the notification title to `<label>` (the session
  label) with the session's terminal title as the body.
- `presence.ts` is an in-memory registry of which push-subscription endpoints
  are currently foreground (TTL-expired, default 30s) so the server can skip
  devices that are actively viewing the dashboard.
- `send.ts` fans a payload out to all subscriptions via `web-push` and prunes
  any subscription that returns HTTP 404/410; an optional `skip(endpoint)`
  predicate omits endpoints (used to skip foreground devices).
- `service.ts` wires these together; the server calls `notifyAttention(sessions)`
  from `publishSessions()` on the same debounced sessions-dir watch signal that
  drives SSE, passing a skip predicate backed by the presence registry.
  `recordPresence(endpoint, foreground)` is fed by the `POST /api/push/presence`
  route.

The browser side registers `src/web/sw.ts` (served at `/sw.js`), subscribes via
`PushManager` using the server's VAPID public key, and shows a notification for
every `push` it receives (`handlePush` in `src/web/pwa/swPush.ts` always calls
`showNotification` — iOS/WebKit revokes the subscription if a service worker
silently swallows a push, so foreground suppression must happen server-side, not
in the worker). The notification is non-silent with a vibration pattern so the
device plays its alert sound/haptics, and tapping it focuses (or opens) the
dashboard deep-linked to the session that needs attention (`/?session=<id>` plus
an `open-session` postMessage to an already-open tab). Push is only offered over
a dev-tunnel origin (`*.devtunnels.ms` + HTTPS). SSE (`/api/events`) remains the
live in-app update channel; Web Push is only for background attention alerts.
The service worker also
precaches the app shell (`/`, `/assets/app.js`, `/assets/xterm.css`) and serves
navigations cache-first (the app bundle network-first, via
`src/web/pwa/swCache.ts`), so an installed PWA boots on cold launch even when a
dev tunnel would return the Microsoft auth redirect; a startup `probeTunnelAuth`
in `App.tsx` then surfaces the "Sign in again" overlay. Cache writes reject
dev-tunnel login responses so an expired session cannot poison the cached shell.

Attention alerting splits by foreground vs. background. While the dashboard is
open in the foreground, the in-app alert manager
(`src/web/attentionAlerts.ts`) raises a subtle Fluent **toast** at the top of
the viewport (`<session name> needs attention` with the terminal title as a
second line, `src/web/attentionToast.ts`) with sound and `navigator.vibrate`,
and tapping it opens the session via
`popSession`. Toasts are suppressed for the session the user is actively viewing
(the client's single "viewed session", mirroring `TerminalView`'s
`terminalVisible` rule — `App.tsx` also auto-acknowledges it so the daemon
clears attention). Otherwise the toast fires whenever the dashboard tab is in the
foreground — including the mobile session list — so an attention event is never
missed (`alertsVisible = pageVisible`).
Background OS-push suppression is done **per device on the server**, not in the
service worker: while notifications are on, each open page runs a presence
reporter (`src/web/pwa/presence.ts`) that POSTs `/api/push/presence`
(`{endpoint, foreground}`) on start, on a ~15s heartbeat, and on every
`visibilitychange` (best-effort `sendBeacon`). The server records the endpoint's
foreground state (`presence.ts`, ~30s TTL) and skips it when sending, so a
device viewing the dashboard gets the toast while other devices still get the OS
push. This keys suppression to the push subscription rather than "any window is
visible", which iOS cannot honour in the worker.

## Remote clients (dev-tunnel uplink)

A devbox runs a singleton **uplink** agent (`climon __uplink`) that connects to
the home machine through a Microsoft dev tunnel. The home machine runs a
loopback-only **ingest** daemon (`climon __ingest` — the Rust client binary,
resolved by the dashboard server; a dev source run requires the Rust binary to
be built and never falls back to the Bun ingest) when `feature.remotes` is
enabled. At startup the server derives a stable tunnel id from the anonymous
global `install.id` (`climon-ingest-<sha256("climon-ingest"+install.id)[:20]>`),
ensures that dev tunnel exists, labels it `climon-ingest`, records it in
`~/.climon/remote-host.json`, and lets the ingest daemon host it. Existing
manually-created tunnel state remains readable for compatibility. `climon
server` no longer accepts a remotes startup flag; config is the only switch. The
ingest also serves a loopback-only **remote-spawn control socket** (advertised
as `controlSocket` in `ingest.json`), dual-listens on `127.0.0.1` when bound to
a non-loopback host so `devtunnel`-forwarded connections still land, and runs a
sessions-dir **dismiss watcher** that suppresses sessions a user deletes locally.

Session I/O is multiplexed over the dev-tunnel TCP stream using a small framed
protocol (`src/remote/mux.ts`): a `hello` frame advertises the devbox's stable
client id, control messages advertise session add/update/remove and
attach/detach, and data messages carry opaque daemon frames.

The ingest handler materializes each remote session as a **local** unix socket
plus a `~/.climon/sessions/<clientId>~<id>.json` metadata file
(`origin: "remote"`). The existing dashboard plumbing (fs.watch → SSE, browser
WS ⇄ unix socket bridge) then works unchanged — it cannot tell local and remote
sessions apart except for the origin tag. Attach is on demand: a browser
connecting to the local socket triggers an `attach` control to the devbox, which
connects to the real daemon socket (replaying scrollback) and bridges bytes back.
The uplink also emits an authoritative `session-list` snapshot each reconcile so
the ingest can garbage-collect ghost sessions deleted on the source (including
those left on disk by a previous connection), while preserving still-present
disconnected sessions and never re-materializing dismissed ones.

## Remote visibility (`ingest-status.json`, `uplink-status.json`, `climon remotes`)

Two single-writer status beacons under `$CLIMON_HOME` make the live remote
topology observable without touching the mux:

- **`ingest-status.json`** — written by the ingest daemon (single writer). It
  carries the ingest `pid`, an `updatedAt` heartbeat (~10s), and one entry per
  connected uplink: `clientId`, friendly `hostname`/`os` (from the enriched
  `hello`), `address`, `connectedAt`, `sessionCount`, and `lastPingAt`.
- **`uplink-status.json`** — written by the uplink supervisor on a devbox
  (single writer): its connection `target`, `connectedAt`, and the current
  lifecycle `state` (`connecting`/`connected`/`reconnecting`/`disconnected`).

Both files are mode `0600` and carry only hostnames/addresses — no secrets, and
they are never network-exposed. **Staleness is always derived by the reader**
(pid dead, or no heartbeat/ping within `STALE_AFTER_MS`); it is never trusted
from the file. The data flow is:

```
ingest / uplink supervisor
        │  (single writer)
        ▼
ingest-status.json / uplink-status.json   ($CLIMON_HOME, 0600)
        │                         │
        ▼                         ▼
  climon remotes          GET /api/remotes (loopback-only)
  (--watch / --json)              │
                                  ▼  SSE "remotes" event
                          dashboard "Remote hosts" menu + panel
```

`hello.hostname`/`hello.os` are untrusted remote input: the ingest sanitizes
them at the trust boundary (cap `hostname` to 64 chars + strip control/ESC
bytes; allowlist `os` to `darwin`/`win32`/`linux`, else `unknown`) before they
are stored, so every downstream sink (`climon remotes` TTY, `--json`, the
dashboard) only ever formats already-safe strings.

## Same-machine WSL <-> Windows discovery (`src/remote/peer.ts`, `discovery.ts`, `link.ts`)

WSL and Windows each keep their own `CLIMON_HOME`, but the filesystems are
mutually visible (`/mnt/c/...` and `\\wsl.localhost\<distro>\...`). `climon link`
(or a lazy auto-link on the first WSL run) records the peer OS's `CLIMON_HOME` in
`remote.peerHome` on both sides. Auto-link only wires discovery: it never enables
the bridge. The bridge is activated only when `feature.wslBridge` is enabled
(typically by accepting the `climon link` prompt or passing `--wsl-bridge`). The
auto-link only fires from WSL, only when a Windows climon is detected, and is
suppressed by `remote.autoLink false`.

`discoverDashboard` resolves a dashboard by reading beacons: the local
`server.json` first (validated by PID liveness), then the peer's by reading its
`ingest.json` and TCP-probing the published ingest host (never the dashboard
`/health` — under default WSL2 NAT a Windows-hosted dashboard binds loopback and
is unreachable from WSL, whereas the ingest is bound to a peer-reachable, published
interface). Ports come from the live beacons, so a collision-bumped port is handled
transparently. The reachable host is the published ingest host, then the
auto-detected candidates (`localhost`, or the WSL default-route gateway IP under
NAT) overridable via `remote.peerHost`. When a peer is found and
`feature.wslBridge` is enabled, the local session's uplink is auto-wired to the
peer's ingest port — reusing the same mux bridge as the dev-tunnel path, just
over a loopback/host-IP TCP connection instead of a tunnel. With
`feature.remotes` enabled but `feature.wslBridge` disabled, dev-tunnel ingest can
run without starting same-machine peer uplinks.

### Cross-OS dashboard handoff (WSL ⇄ Windows)

A machine with `remote.peerHome` set and `feature.wslBridge` enabled is, at any
moment, either **host** (runs the dashboard server + ingest) or **client** (runs
an uplink to the host). Switching OS moves the host role. Cross-OS promote and
the settle/demotion handoff are gated on `feature.wslBridge` independently of
`feature.remotes`; enabling dev-tunnel remotes alone never promotes, demotes, or
spawns a same-machine peer uplink:

- **Bind/publish**: the host's ingest binds a peer-reachable interface via
  `resolveIngestBindHost` (loopback when WSL hosts; the `vEthernet (WSL)` IPv4 when
  Windows hosts) and publishes it as `host` in `ingest.json`, so the client OS and
  promote read the live address instead of a hardcoded one.
- **Promote** (`bun run server`): reads the peer's `server.json` and `ingest.json`,
  then displaces the peer host entirely over the shared filesystem — it TCP-probes
  the peer ingest and, if it is listening, writes a token-free
  `shutdown-request.json` into the peer's `CLIMON_HOME`. It proceeds when the peer
  is gone (clearing stale beacons) and aborts (advising `climon cleanup`) rather
  than running a second ingest past a live, un-clearable peer. The network carries
  only the data plane. After binding, a brief **settle window** re-reads the peer
  `server.json` to catch a contested promote (e.g. the peer was unreachable over
  TCP under WSL2 NAT, so the direct handoff could not complete): the
  most-recently-started server wins by comparing the `startedAt` timestamps and
  force-demotes the loser over the filesystem, so a deliberately-started newcomer
  takes over regardless of OS. An exact start-time tie — or a peer whose
  `server.json` predates `startedAt` — falls back to the deterministic OS rule
  (WSL stays host). Both sides compare the same timestamps, so the outcome
  converges no matter which re-checks first.
- **Demote**: the peer's durable **ingest** watches its own home (`fs.watch` + ~1s
  poll); on a well-formed request it spawns an uplink toward the new host, stops the
  co-located dashboard server, frees the ingest port, removes its beacons (and the
  consumed request), and exits. The ingest is the single demotion anchor, so a
  handoff works even when the peer's dashboard server has already been `Ctrl-C`'d.

Two server shutdown modes: **plain** (Ctrl-C / SIGINT / SIGTERM / internal HTTP)
stops the co-located ingest too, except when the shutdown was requested by the
ingest itself as part of a demotion handoff (`shouldStopIngestForShutdown`);
**handoff** demotion is driven
by the ingest itself when it observes a `shutdown-request.json` in its home — it
stops the co-located server, spawns an uplink toward the new host, frees its
listener, and exits. The
**ingest** is the durable control anchor: it owns `ingest.json`
(`{pid,port,host}`) and, as a detached singleton, survives a server crash and an
ingest-driven demotion stop (it is only torn down on a plain server shutdown).
Every
consumer reads the bound ingest port from `ingest.json` via `resolveIngestPort`.
