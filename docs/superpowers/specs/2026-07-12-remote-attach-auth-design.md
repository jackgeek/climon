# Remote Session Attach Authentication — Design

**Status:** Approved (brainstorming)
**Date:** 2026-07-12
**Branch:** `fix/remote-attach-auth`
**Type:** Bug fix (regression from PR #126)

## Problem

Remote (devbox) sessions listed on the dashboard show a **blank xterm** when
opened, even though their metadata, status, and needs-attention updates flow
correctly. Local sessions work fine.

### Root cause

PR #126 ("Authenticated session IPC (CWE-306 remediation)", commit `36bd9d1f`)
switched the dashboard's browser-attach WebSocket `open` handler from a raw
`connectSessionSocket(ws.data.socketPath)` to
`connectAuthenticatedSession(ws.data.sessionId)`. The authenticated path reads a
per-session `<id>.ipc-auth` credential sidecar and performs a mutual-HMAC
handshake with the session daemon.

- **Local** sessions get that sidecar from their Rust daemon
  (`rust/climon-store/src/ipc_auth.rs` → `host.rs`).
- **Remote** sessions are materialized by the **production Rust ingest**
  (`climon __ingest` → `climon_remote::ingest::run_ingest_daemon`,
  `rust/climon-remote/src/ingest.rs` `add_session`), which writes metadata + a
  raw byte-forwarding loopback proxy socket but **never** writes an `.ipc-auth`
  record and runs **no** handshake on the proxy.

  > **Codebase note:** the Bun `src/remote/ingest.ts` is frozen legacy —
  > `runIngestConnection` has zero production callers. All client/remote work
  > (per repo convention) lives in the Rust `climon-remote` crate, and that is
  > where this fix goes. An earlier draft of this spec attributed the bug to the
  > Bun ingest; that was incorrect.

Result: for every remote session, `connectAuthenticatedSession` calls
`readIpcAuthRecord` → returns `null` → **throws** → the `open` handler's
`catch { ws.close(); }` runs → blank terminal. Because the handler closes before
bridging, the proxy socket is never connected, so the ingest never sends its
`attach` control frame to the devbox — which is exactly why the devbox uplink
log shows `connected` + `reconciled(6)` but **no `attach` line**.

The failure is also **silent**: the `catch` logs nothing and shows the browser
no error, which is why the bug went undiagnosed.

## Goal

Give remote sessions the same authenticated IPC as local sessions so the browser
attach handshake succeeds and terminals render, and make attach failures
observable so a future regression cannot hide silently.

## Non-goals

- No change to the dev-tunnel transport, mux framing, or metadata namespacing.
- No change to the Bun dashboard server's attach *auth* path — it already reads
  the sidecar via `connectAuthenticatedSession` and runs the client handshake.
  The ingest fix is in the Rust `climon-remote` crate; the only Bun changes are
  the observable-failure path (server + web).
- No new feature-catalogue entry (`docs/features.md`) — this restores intended
  behavior rather than adding a feature.

## Architecture

The ingest proxy becomes a mini-daemon. For each materialized remote session it:

1. mints a per-session credential and publishes an `<id>.ipc-auth` sidecar whose
   `endpoint` is the loopback proxy ref (`tcp://127.0.0.1:<port>`), and
2. runs the **server** side of the existing mutual-HMAC handshake on each inbound
   browser proxy connection **before** bridging any bytes to the devbox.

The dashboard server's browser-attach path is unchanged: it already reads the
sidecar via `connectAuthenticatedSession(namespacedId)` and runs the client
handshake. It only needs a credential to exist and a peer that speaks the server
handshake — both provided here.

### Wire protocol (already specified)

The handshake is the existing 4-step protocol shared with the Rust daemon
(`rust/climon-session/src/auth.rs`, spec lines 290-389):

```
daemon → client : AuthChallenge { version, reserved=0, challenge_nonce(32) }
client → daemon : AuthResponse  { purpose(1), response_nonce(32), client_proof(32) }
daemon → client : AuthOk { daemon_proof(32) }        (Purpose.Session)
              or  AuthProbeOk { daemon_proof(32) }   (Purpose.Probe)
              or  AuthError { code(1) }
```

All primitives already exist in Rust and are reused as-is:
`climon_session::auth::daemon_handshake` / `client_handshake`, the
`Purpose`/`AuthErrorCode` types, and `climon_store::ipc_auth::{mint, write,
remove}`. `std::net::TcpStream` implements `SessionStream`, so the blocking
handshake runs directly on the accepted proxy socket. **No new handshake or
credential code is written** — the ingest simply calls the same functions the
local session daemon already uses.

## Components

### 1. Reused Rust primitives (no new code)

- `climon_store::ipc_auth::mint(endpoint)` / `write(env, id, record)` /
  `remove(env, id)` — the same on-disk sidecar the local daemon publishes
  (`rust/climon-store/src/ipc_auth.rs`).
- `climon_session::auth::daemon_handshake(&mut dyn SessionStream, &[u8])` — the
  **blocking** server half of the mutual-HMAC handshake. It reads exactly the
  frames it needs (no read-ahead), so there is no leftover-buffer problem: any
  bytes the client pipelined after `AuthResponse` stay in the kernel buffer and
  are read by the async bridge after the handshake.
- `std::net::TcpStream: SessionStream` (`rust/climon-session/src/socket.rs:290`).

### 2. Async ↔ blocking bridge (the one non-obvious bit)

The ingest accept loop is tokio-async; `daemon_handshake` is blocking. Per
accepted proxy connection: `stream.into_std()` → `set_nonblocking(false)` →
`set_read_timeout(Some(10s))` → run `daemon_handshake` inside
`tokio::task::spawn_blocking` → on success `set_nonblocking(true)` +
`TcpStream::from_std` and resume the existing async `into_split()` bridge; on
failure log and drop the socket (never send `Attach`).

### 3. `rust/climon-remote/src/ingest.rs` — publish credential + gate the proxy

`RemoteSession` gains a `credential: Vec<u8>` field.

In `add_session`, after the loopback listener is bound, the ref is resolved, and
the meta is written:
- `let record = climon_store::ipc_auth::mint(&resolved);`
- `climon_store::ipc_auth::write(store_env, &local_id, &record)?;` (on failure:
  `eprintln!` a warning, remove the just-written meta, drop the listener, and
  skip materializing the proxy — never leave an unauthenticated proxy open).
- keep `record.credential_bytes()` on the `RemoteSession`.

In the accept loop's connection handler, before adding the socket / sending
`Attach`:
- run `daemon_handshake` (via the async↔blocking bridge above);
- **on success:** insert the socket, `send(Attach)`, and wire the existing
  reader/writer bridge unchanged;
- **on failure:** `eprintln!("climon: warning: ingest attach handshake failed
  for {local_id}: {e}")` and drop the socket. Never send `Attach`.

In `remove_session`, `remove_session_deleting`, and the dismissal branch of
`add_session`, call `climon_store::ipc_auth::remove(store_env, &local_id)`
alongside the existing socket cleanup so no stale credential file survives the
session (mirroring the local daemon's teardown in `host.rs`).

### 4. `src/server/server.ts` + `src/web/components/TerminalView.tsx` — observable attach failure

Inbound **binary** ws frames at attach time are gated by the terminal's
replay/first-frame logic (`TerminalView.tsx` ~884-908), so a raw binary error
string can be reset away or misinterpreted. Instead use a dedicated JSON control
message, handled in the existing string branch (~830-882) alongside `exit` /
`size` / `control` / `replay`.

Server (`src/server/server.ts`, ws `open` handler `catch`):
- log server-side (component `server`) with the sessionId and error;
- `ws.send(JSON.stringify({ type: "error", message: reason }))` then
  `ws.close()`. Keep `reason` a short, non-sensitive string (never the
  credential/nonce) — e.g. the `Error.message` from
  `connectAuthenticatedSession`.

Web (`src/web/components/TerminalView.tsx`, `ws.onmessage` string branch): add an
`else if (msg.type === "error")` case that writes a red ANSI line to xterm:
`term.write("\r\n\x1b[31mclimon: cannot attach — " + msg.message + "\x1b[0m\r\n")`.
Extend the parsed message type with an optional `message?: string`.

## Data flow

```
browser ─ws─▶ server open handler
              └─ connectAuthenticatedSession(namespacedId)
                   └─ readIpcAuthRecord(namespacedId)  ← NEW sidecar
                   └─ connect tcp://127.0.0.1:<proxyPort>
                   └─ clientHandshake  ⇄  daemon_handshake (Rust ingest proxy)  ← NEW gate
              on success: proxy send(attach) ─mux─▶ devbox uplink
                          devbox PTY frames ─mux─▶ proxy ─socket─▶ server ─ws─▶ browser xterm
              on failure: log (component server) + ws.send {type:"error"} → xterm red line + ws.close()
```

## Error handling

| Failure | Behavior |
|---|---|
| Proxy handshake fails (bad/absent proof) | `daemon_handshake` returns `Err`; the ingest drops the proxy socket; no `Attach`; existing `detach`-on-last-close still applies. |
| Sidecar write fails in `add_session` | `eprintln!` warning; remove the just-written meta and drop the loopback listener; skip materializing that session's proxy. |
| Server-side `connectAuthenticatedSession` throws | Log (component `server`, key `server.attach_failed`) + `ws.send {type:"error"}` (rendered as a red xterm line) + `ws.close()`. |

## Testing (TDD)

**Rust unit/integration — in-module `#[cfg(test)] mod tests` in
`rust/climon-remote/src/ingest.rs`** (following the existing
`add_session_respects_dismissal` template, which shows `make_test_store_env`,
`read_meta`, and the `add_session(...)` signature):
- `add_session` writes a `<local_id>.ipc-auth` sidecar whose `endpoint` equals
  the materialized meta's `socket_path`; `version == 1`, credential is 64 hex.
- A **raw** connect to the loopback proxy (no handshake) emits **no** `Attach`
  control frame and is dropped.
- An authenticated connect (`client_handshake` with the sidecar credential)
  produces an `Attach` frame for the session id, then bridges bytes.

No new server/handshake primitives are added, so the Rust `climon-session`
handshake and `climon-store` ipc-auth already have their own coverage — this
plan only tests the ingest wiring.

**Bun — observability half:** no new Bun handshake/store tests (those primitives
are unchanged). The web `{type:"error"}` render and server error frame are
covered by the existing `tests/terminal-panel.test.ts` sanity run plus the
manual checks below.

All Rust tests isolate state with a temp store env (`make_test_store_env`); the
loopback proxy binds `127.0.0.1`, so no special filesystem is required.

## Docs

- `docs/security.md` — note remote sessions now use the same authenticated
  loopback IPC as local, closing the CWE-306 gap for the remote proxy hop.
- `docs/manual-tests/remote-attach-auth.md` — new manual check: open a remote
  session → terminal renders; corrupt/remove the sidecar → visible red error in
  the terminal and a server log line. Link it from `docs/manual-tests/README.md`.

## Rollout / compatibility

- Backward compatible: local sessions and their sidecars are untouched. Remote
  sessions materialized by an **older** ingest that predates this change simply
  won't have a sidecar and will show the (now visible) attach error until the
  server is upgraded — no worse than today's blank terminal, and now diagnosable.
- No config-setting or feature-flag changes, so no fixture/`docs:config`
  regeneration needed.
