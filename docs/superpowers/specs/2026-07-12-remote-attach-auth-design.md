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
- **Remote** sessions are materialized by the Bun ingest bridge
  (`src/remote/ingest.ts` `addSession`), which writes metadata + a raw
  byte-forwarding loopback proxy socket but **never** writes an `.ipc-auth`
  record.

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
- No change to the Rust client. The ingest bridge is Bun server code
  (`src/remote/ingest.ts`) that the dashboard server imports directly.
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

All primitives (`randomNonce`, `verifyClientProof`, `daemonProof`,
`clientProof`, `verifyDaemonProof`, `Purpose`, `AuthErrorCode`,
`IPC_PROTOCOL_VERSION`, `NONCE_LEN`, `PROOF_LEN`, `PRE_AUTH_MAX_PAYLOAD`) are
already exported from `src/ipc/auth.js`. TypeScript currently has only the client
half (`clientHandshake` in `src/ipc/handshake.ts`); this adds the server half.

## Components

### 1. `src/ipc/handshake.ts` — add `serverHandshake`

```ts
export function serverHandshake(
  socket: Socket,
  credential: Uint8Array,
  timeoutMs = 5000,
): Promise<Buffer>
```

Mirrors the Rust `daemon_handshake`:
1. Send `AuthChallenge` = `version(1) || reserved(1)=0 || challenge_nonce(32)`.
2. Read `AuthResponse`; validate length `1 + NONCE_LEN + PROOF_LEN` and purpose.
3. `verifyClientProof` (constant-time). On failure send `AuthError(BadProof)` and
   reject; malformed frames send `AuthError(Malformed)`.
4. Send `AuthOk` (Purpose.Session) or `AuthProbeOk` (Purpose.Probe) carrying the
   `daemonProof`.
5. Resolve with any bytes received **after** the consumed `AuthResponse` frame
   (leftover the client pipelined), mirroring how `clientHandshake` returns
   leftover. Use `FrameDecoder` with `setMaxPayload(PRE_AUTH_MAX_PAYLOAD)` and a
   timeout, cleaning up `data`/`error`/`close` listeners on settle.

### 2. `src/ipc/ipc-auth-store.ts` — credential mint + write + remove

```ts
export function mintIpcCredential(endpoint: string): IpcAuthRecord // {version:1, generation:hex(16B), endpoint, credential:hex(32B)}
export async function writeIpcAuthRecord(id: string, record: IpcAuthRecord): Promise<void> // atomic, mode 0o600
export async function removeIpcAuthRecord(id: string): Promise<void> // idempotent (ENOENT ok)
```

`mintIpcCredential` matches the Rust `mint` on-disk shape
(`rust/climon-store/src/ipc_auth.rs`): `version = 1`, `generation` = 16 random
bytes hex, `credential` = 32 random bytes hex. Use `randomBytes` from
`node:crypto`. Writes validate the id via the existing `validateSessionId`. Use
an owner-only atomic write (temp file + `rename`, `mode: 0o600`, with a `chmod`
fallback for platforms that ignore the create mode — same pattern as
`src/config.ts`).

### 3. `src/remote/ingest.ts` — publish credential + gate the proxy

`RemoteSession` gains a `credential: Uint8Array` field.

In `addSession`, after `listenOnSessionSocket` resolves `actualSocketPath`:
- `const record = mintIpcCredential(actualSocketPath);`
- `await writeIpcAuthRecord(localId, record);`
- keep `record`'s decoded credential bytes on the session entry.
- If the sidecar write throws, log `ingest.ipc_auth_write_failed` and tear down
  the just-created proxy server (do not leave an unauthenticated proxy open).

In the `createNetServer((socket) => …)` connection handler, replace the
immediate add/attach with:
- run `serverHandshake(socket, credential)`;
- **on success:** add socket to `sockets`, forward the resolved leftover Buffer
  to the devbox as `encodeData(meta.id, leftover)` if non-empty, `send(attach)`,
  then wire `socket.on("data", …)` and close/error cleanup as today;
- **on failure:** log `ingest.attach_handshake_failed` (with reason) and
  `socket.destroy()`. Never send `attach`.

In `removeSession` and the dismissal branch of `addSession`, call
`await removeIpcAuthRecord(localId)` alongside the existing socket cleanup so no
stale credential file survives the session.

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
                   └─ clientHandshake  ⇄  serverHandshake (ingest proxy)  ← NEW gate
              on success: proxy send(attach) ─mux─▶ devbox uplink
                          devbox PTY frames ─mux─▶ proxy ─socket─▶ server ─ws─▶ browser xterm
              on failure: log (component server) + ws.send {type:"error"} → xterm red line + ws.close()
```

## Error handling

| Failure | Behavior |
|---|---|
| Proxy handshake fails (bad/absent proof) | `AuthError` sent by server handshake; proxy destroys socket; no `attach`; existing `detach`-on-last-close still applies. |
| Sidecar write fails in `addSession` | Log `ingest.ipc_auth_write_failed`; tear down the new proxy server; skip materializing that session's proxy. |
| Server-side `connectAuthenticatedSession` throws | Log (component `server`) + `ws.send {type:"error"}` (rendered as a red xterm line) + `ws.close()`. |

## Testing (TDD)

**Unit — `tests/ipc-handshake.test.ts`:**
- `serverHandshake` happy path with a real `clientHandshake` peer over a socket
  pair: both verify proofs; server resolves empty leftover.
- Bad credential: client observes `HandshakeError` with `AuthErrorCode.BadProof`.
- Leftover: client pipelines extra bytes after `AuthResponse`; server resolves
  them in the returned Buffer.
- Timeout: no `AuthResponse` → server rejects after `timeoutMs`.

**Unit — `tests/ipc-auth.test.ts`:**
- `mintIpcCredential` yields 64-hex `credential`, distinct across calls, `version = 1`.
- `writeIpcAuthRecord` → `readIpcAuthRecord` roundtrips the record.
- Written file mode is `0o600` (skip the mode assert on Windows).

**Integration — `tests/ingest.test.ts`:**
- After a `session-added` control frame, read the materialized `<id>.ipc-auth`,
  connect to the proxy, complete `clientHandshake` with that credential, and
  assert (a) an `attach` control frame is emitted to the mock devbox channel and
  (b) devbox→browser and browser→devbox bytes bridge.
- A **raw** connect (no handshake) receives **no** `attach` frame and is dropped.

All tests isolate state with `CLIMON_HOME` pointing at a temp dir (socket tests
need a real filesystem temp dir).

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
