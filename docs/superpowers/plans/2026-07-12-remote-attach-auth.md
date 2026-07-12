# Remote Session Attach Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give remote (devbox) sessions the same authenticated loopback IPC as local sessions so the dashboard's browser-attach handshake succeeds and terminals render, and make attach failures visible in the terminal instead of silently blanking.

**Architecture:** The **production ingest is Rust** (`rust/climon-remote/src/ingest.rs`, run by `climon __ingest`). For each materialized remote session it binds a loopback proxy but currently writes **no** `<id>.ipc-auth` sidecar and runs **no** handshake — so the Bun dashboard's `connectAuthenticatedSession` (added in PR #126) throws and blanks the terminal. This plan makes the Rust ingest mint/write the sidecar (endpoint = the resolved loopback proxy ref) and run the existing `climon_session::auth::daemon_handshake` on every inbound browser proxy connection before bridging. The Bun dashboard server already reads that sidecar and runs the client half — no Bun ingest changes are needed. Separately, the Bun server's attach-failure path is made observable: it sends a `{type:"error"}` control message that the web terminal renders as a red line.

**Tech Stack:** Rust (tokio async ingest, blocking `daemon_handshake` over `std::net::TcpStream`, `climon_store::ipc_auth`, `climon_session::auth`); Bun + TypeScript ESM (dashboard server/web), `bun:test`, React 19 + xterm.js.

---

## CRITICAL context: which code actually runs (read first)

- **Production ingest = Rust.** `climon __ingest` → `run_ingest_entry` →
  `climon_remote::ingest::run_ingest_daemon` (`rust/climon-cli/src/run.rs:365-421`).
  The loopback proxy that the browser attaches to is bound in
  `add_session` (`rust/climon-remote/src/ingest.rs:1239`).
- **The Bun `src/remote/ingest.ts` is frozen legacy** — `runIngestConnection`
  has **zero callers** outside its own file and tests. Do **not** change it for
  this fix; it does not run in production. (An earlier draft of this plan
  targeted it; that was wrong.)
- **Local sessions already work** because the Rust *session daemon* mints/writes
  the sidecar and runs the daemon handshake
  (`rust/climon-session/src/host.rs:897-898`, `auth.rs:69`). This plan gives the
  *ingest* the same behavior for remote sessions.
- **The Bun dashboard server IS production** and already reads the sidecar via
  `connectAuthenticatedSession` (`src/session-socket.ts:81`) using the Bun
  `clientHandshake`. It only needs a sidecar to exist and a peer that speaks the
  server handshake — both provided by the Rust ingest here. Its only change is
  the observable-failure path (Tasks 3-4).

## Reusable primitives (already exist — do not reimplement)

- `climon_store::ipc_auth::mint(endpoint: &str) -> IpcAuthRecord` — version=1,
  16-byte hex generation, 32-byte hex credential
  (`rust/climon-store/src/ipc_auth.rs:35`).
- `climon_store::ipc_auth::write(env: &Env, id: &str, record: &IpcAuthRecord)`
  — atomic owner-only write (`ipc_auth.rs:49`).
- `climon_store::ipc_auth::remove(env: &Env, id: &str)` — idempotent
  (`ipc_auth.rs:68`).
- `IpcAuthRecord::credential_bytes(&self) -> StoreResult<Vec<u8>>`
  (`ipc_auth.rs:28`).
- `climon_session::auth::daemon_handshake(stream: &mut dyn SessionStream,
  credential: &[u8]) -> Result<Purpose>` — **blocking**, sends AuthChallenge,
  verifies the client proof (constant-time), replies AuthOk/AuthProbeOk, and
  reads **exactly** the frames it needs (no read-ahead → no leftover buffering)
  (`rust/climon-session/src/auth.rs:69`).
- `climon_session::auth::client_handshake(stream, credential, purpose)` —
  blocking client half, used by the tests (`auth.rs:138`).
- `std::net::TcpStream` implements `SessionStream`
  (`rust/climon-session/src/socket.rs:290`), so the blocking handshake runs
  directly on it.
- `climon_session::socket::{format_session_socket_ref, parse_session_socket_ref,
  ParsedRef}` (`socket.rs:89-140`).

`climon-remote` already depends on `climon-session`, `climon-store`, and
`climon-proto` (`rust/climon-remote/Cargo.toml:13-16`).

## Async ↔ blocking integration (the one non-obvious bit)

The ingest accept loop uses tokio `TcpStream`; `daemon_handshake` is blocking and
takes a `SessionStream` (implemented for `std::net::TcpStream`). Bridge them per
connection:

1. `let std = stream.into_std()?; std.set_nonblocking(false)?;`
   `std.set_read_timeout(Some(Duration::from_secs(10)))?;`
2. Run the handshake off the async runtime and hand the stream back:
   `let handshaken = tokio::task::spawn_blocking(move || {`
   `    let mut s = std; climon_session::auth::daemon_handshake(&mut s, &cred).map(|_| s)`
   `}).await;`
3. On `Ok(Ok(s))`: `s.set_nonblocking(true)?; let stream = TcpStream::from_std(s)?;`
   then continue with the existing split/bridge. Because the handshake never
   reads past the `AuthResponse` frame, any bytes the client pipelined afterward
   are still in the kernel buffer and are read by the async reader — no leftover
   handling required.
4. On failure (`Ok(Err(_))` / `Err(_)`): log and drop the socket; **never** send
   `Attach`.

## File structure

- `rust/climon-remote/src/ingest.rs` — add `credential` to `RemoteSession`; in
  `add_session` mint+write the sidecar and gate the accept loop with
  `daemon_handshake`; remove the sidecar in every teardown path.
- `src/server/server.ts` — ws `open` handler `catch`: log + send
  `{type:"error"}` + close.
- `src/web/components/TerminalView.tsx` — render `{type:"error"}` as a red line.
- `src/i18n/messages.en.json` — catalog entry for the new `server.attach_failed`
  log key.
- Docs: `docs/security.md`, `docs/manual-tests/remote-attach-auth.md`,
  `docs/manual-tests/README.md`.

## Out of scope for THIS plan

The devbox-delete/dismiss propagation ("dismissing a disconnected remote session
should delete its files on the devbox so it can't reappear") is a **separate
cross-process control-plane feature** (new signed control message + devbox-side
removal + durable delivery for disconnected sessions). It is being handled under
its own brainstormed spec and is intentionally not part of this bug fix.

---

## Task 1: Rust ingest mints/writes the sidecar and gates the proxy with `daemon_handshake`

**Files:**
- Modify: `rust/climon-remote/src/ingest.rs`
- Test: in-module `#[cfg(test)] mod tests` at the bottom of the same file.

Work from `rust/climon-remote/`.

- [ ] **Step 1: Write the failing test**

Add these two tests to the `#[cfg(test)] mod tests` block (they follow the style
of the existing `add_session_respects_dismissal`, which shows `make_test_store_env`,
`read_meta`, and the `add_session(&meta, &label, &mut sessions, &store_env, max,
&tx, &registry)` signature):

```rust
    #[tokio::test]
    async fn add_session_writes_ipc_auth_sidecar_with_proxy_endpoint() {
        let store_env = Arc::new(make_test_store_env());
        let label = "client-1";
        let remote_id = "s1";
        let local_id = namespaced_id(label, remote_id);
        let mut sessions: HashMap<String, RemoteSession> = HashMap::new();
        let (tx, _rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let meta = serde_json::json!({
            "id": remote_id, "command": ["bash"], "displayCommand": "bash", "cwd": "/home/dev",
            "status": "running", "priorityReason": "running",
            "cols": 80, "rows": 24, "createdAt": "t", "updatedAt": "t", "lastActivityAt": "t"
        });

        add_session(&meta, &Some(label.to_string()), &mut sessions, &store_env, 16, &tx, &None).await;

        let record = climon_store::ipc_auth::read(&store_env, &local_id)
            .unwrap()
            .expect("ipc-auth sidecar must exist");
        assert_eq!(record.version, 1);
        assert_eq!(record.credential.len(), 64);
        let stored = read_meta(&store_env, &local_id).expect("meta written");
        assert_eq!(record.endpoint, stored.socket_path);

        // Cleanup the proxy accept task.
        for (_, s) in sessions.drain() {
            s.accept_handle.abort();
        }
    }

    #[tokio::test]
    async fn proxy_requires_handshake_before_attach() {
        use climon_proto::auth::Purpose;
        use climon_session::auth::client_handshake;
        use climon_session::socket::{parse_session_socket_ref, ParsedRef};

        let store_env = Arc::new(make_test_store_env());
        let label = "client-1";
        let remote_id = "s1";
        let local_id = namespaced_id(label, remote_id);
        let mut sessions: HashMap<String, RemoteSession> = HashMap::new();
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let meta = serde_json::json!({
            "id": remote_id, "command": ["bash"], "displayCommand": "bash", "cwd": "/home/dev",
            "status": "running", "priorityReason": "running",
            "cols": 80, "rows": 24, "createdAt": "t", "updatedAt": "t", "lastActivityAt": "t"
        });
        add_session(&meta, &Some(label.to_string()), &mut sessions, &store_env, 16, &tx, &None).await;

        let record = climon_store::ipc_auth::read(&store_env, &local_id).unwrap().unwrap();
        let (host, port) = match parse_session_socket_ref(&record.endpoint).unwrap() {
            ParsedRef::Tcp { host, port } => (host, port),
            other => panic!("expected tcp ref, got {other:?}"),
        };
        let cred = record.credential_bytes().unwrap();

        // 1) Raw connect (no handshake): must NOT produce an Attach frame.
        let raw = TcpStream::connect((host.as_str(), port)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(rx.try_recv().is_err(), "raw connect must not emit Attach");
        drop(raw);

        // 2) Authenticated connect: after client_handshake, Attach must appear.
        let cli = TcpStream::connect((host.as_str(), port)).await.unwrap();
        let std_cli = cli.into_std().unwrap();
        std_cli.set_nonblocking(false).unwrap();
        let cred2 = cred.clone();
        let handshaken = tokio::task::spawn_blocking(move || {
            let mut s = std_cli;
            client_handshake(&mut s, &cred2, Purpose::Session).map(|_| s)
        })
        .await
        .unwrap();
        let std_cli = handshaken.expect("client handshake succeeds");

        let frame = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("Attach within 1s")
            .expect("channel open");
        let mut decoder = crate::mux::MuxDecoder::new();
        let msgs = decoder.push(&frame);
        assert!(
            msgs.iter().any(|m| matches!(
                m,
                crate::mux::MuxMessage::Control(crate::mux::ControlMessage::Attach { id }) if id == remote_id
            )),
            "expected Attach for {remote_id}, got {msgs:?}"
        );

        drop(std_cli);
        for (_, s) in sessions.drain() {
            s.accept_handle.abort();
        }
    }
```

Verify against the real API while writing:
- `MuxDecoder::new()` / `MuxDecoder::push` and the `MuxMessage`/`ControlMessage`
  variant names (`rust/climon-remote/src/mux.rs`) — adjust the decode+match to
  the actual shape (the existing mux tests near `mux.rs:399` show it).
- `read_meta` returns the stored `SessionMeta`; use its `socket_path` field.
- `make_test_store_env` and `read_meta` are the existing test helpers in this
  module.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p climon-remote add_session_writes_ipc_auth_sidecar proxy_requires_handshake`
Expected: FAIL — no sidecar is written (`read` returns `None` → `expect` panics),
and the raw connect currently DOES emit `Attach` (the handshake gate does not
exist yet).

- [ ] **Step 3: Add the `credential` field to `RemoteSession`**

In `rust/climon-remote/src/ingest.rs` (~line 846):

```rust
struct RemoteSession {
    local_id: String,
    sockets: LocalSockets,
    accept_handle: tokio::task::JoinHandle<()>,
    /// Decoded 32-byte IPC credential this session's proxy authenticates with.
    credential: Vec<u8>,
}
```

- [ ] **Step 4: Mint + write the sidecar and gate the accept loop in `add_session`**

In `add_session`, the current flow (lines ~1239-1320) is: bind listener → resolve
ref → write meta → spawn accept task → insert `RemoteSession`. Replace the block
from `let meta_local = to_local_meta(...)` through the `sessions.insert(...)` call
with the version below. Changes: (a) mint+write the sidecar after the meta write,
tearing everything down if the write fails; (b) run `daemon_handshake` inside the
accept loop before `Attach`/bridge.

```rust
    let meta_local = to_local_meta(meta, &label, &local_id, &resolved);
    if write_session_meta(store_env, &meta_local).is_err() {
        return;
    }

    // Publish the per-session IPC credential (endpoint = resolved loopback proxy
    // ref) so the dashboard server can authenticate its browser-attach, matching
    // local sessions. Never leave an unauthenticated proxy open.
    let record = climon_store::ipc_auth::mint(&resolved);
    if climon_store::ipc_auth::write(store_env, &local_id, &record).is_err() {
        eprintln!("climon: warning: ingest could not write IPC credential for {local_id}; skipping proxy");
        let _ = remove_session_meta(store_env, &local_id);
        return; // `listener` is dropped here, freeing the loopback port.
    }
    let credential = record.credential_bytes().unwrap_or_default();

    let sockets: LocalSockets = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let accept_sockets = sockets.clone();
    let accept_send = send_tx.clone();
    let accept_remote_id = remote_id.clone();
    let accept_local_id = local_id.clone();
    let accept_credential = credential.clone();
    let next_id = Arc::new(AtomicU64::new(0));
    let accept_handle = tokio::spawn(async move {
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(pair) => pair,
                Err(_) => break,
            };

            // Authenticate the browser proxy connection (mutual-HMAC) before
            // bridging any bytes to the devbox. daemon_handshake is blocking and
            // runs over std::net::TcpStream; run it off the async runtime.
            let std_stream = match stream.into_std() {
                Ok(s) => s,
                Err(_) => continue,
            };
            if std_stream.set_nonblocking(false).is_err() {
                continue;
            }
            let _ = std_stream.set_read_timeout(Some(Duration::from_secs(10)));
            let cred = accept_credential.clone();
            let handshaken = tokio::task::spawn_blocking(move || {
                let mut s = std_stream;
                climon_session::auth::daemon_handshake(&mut s, &cred).map(|_| s)
            })
            .await;
            let std_stream = match handshaken {
                Ok(Ok(s)) => s,
                Ok(Err(e)) => {
                    eprintln!("climon: warning: ingest attach handshake failed for {accept_local_id}: {e}");
                    continue;
                }
                Err(_) => continue, // join error (panic/cancel)
            };
            if std_stream.set_nonblocking(true).is_err() {
                continue;
            }
            let stream = match TcpStream::from_std(std_stream) {
                Ok(s) => s,
                Err(_) => continue,
            };

            let socket_id = next_id.fetch_add(1, Ordering::SeqCst);
            let (to_local_tx, mut to_local_rx) = mpsc::unbounded_channel::<Vec<u8>>();
            accept_sockets.lock().await.insert(socket_id, to_local_tx);
            let _ = accept_send.send(encode_control(&ControlMessage::Attach {
                id: accept_remote_id.clone(),
            }));

            let (mut rd, mut wr) = stream.into_split();
            let writer = tokio::spawn(async move {
                while let Some(bytes) = to_local_rx.recv().await {
                    if wr.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
            });
            let reader_sockets = accept_sockets.clone();
            let reader_send = accept_send.clone();
            let reader_remote_id = accept_remote_id.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    match rd.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if let Ok(frame) = encode_data(&reader_remote_id, &buf[..n]) {
                                let _ = reader_send.send(frame);
                            }
                        }
                    }
                }
                let empty = {
                    let mut map = reader_sockets.lock().await;
                    map.remove(&socket_id);
                    map.is_empty()
                };
                writer.abort();
                if empty {
                    let _ = reader_send.send(encode_control(&ControlMessage::Detach {
                        id: reader_remote_id.clone(),
                    }));
                }
            });
        }
    });

    sessions.insert(
        remote_id,
        RemoteSession {
            local_id,
            sockets,
            accept_handle,
            credential,
        },
    );
```

Note: this preserves the existing reader/writer/cleanup bodies verbatim; only the
handshake gate, the sidecar publish, and the new `credential` field are added.

- [ ] **Step 5: Remove the sidecar in every teardown path**

`add_session` dismissal branch (~lines 1217-1223) — after `existing.sockets
.lock().await.clear();`, add:

```rust
        let _ = climon_store::ipc_auth::remove(store_env, &local_id);
```

`remove_session` (~lines 1323-1338) — after
`session.sockets.lock().await.clear();`, add:

```rust
        let _ = climon_store::ipc_auth::remove(store_env, &session.local_id);
```

`remove_session_deleting` (~lines 1349-1358) — after
`session.sockets.lock().await.clear();`, add:

```rust
        let _ = climon_store::ipc_auth::remove(store_env, &session.local_id);
```

(These mirror the local daemon, which removes the sidecar on teardown —
`host.rs:1023`.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p climon-remote add_session_writes_ipc_auth_sidecar proxy_requires_handshake add_session_respects_dismissal`
Expected: PASS (new tests green; the existing dismissal test still passes).

- [ ] **Step 7: Build the workspace and lint (dependent crates + exhaustive matches)**

Run: `cargo build --workspace && cargo clippy -p climon-remote --all-targets`
Expected: builds clean, no new clippy warnings. (Per repo practice, build the whole
workspace after touching a shared struct so dependent crates' matches are checked.)

- [ ] **Step 8: Commit**

```bash
git add rust/climon-remote/src/ingest.rs
git commit -m "fix(remote): authenticate the ingest attach proxy so remote terminals render"
```

---

## Task 2: Server surfaces attach failures instead of blanking

**Files:**
- Modify: `src/server/server.ts` (ws `open` handler `catch`, ~lines 2126-2133)
- Modify: `src/i18n/messages.en.json` (add `server.attach_failed`)

Work from the repo root (Bun).

- [ ] **Step 1: Update the `open` handler `catch`**

In `src/server/server.ts`, replace:

```ts
      async open(ws: ServerWebSocket<WsData>) {
        let session;
        try {
          session = await connectAuthenticatedSession(ws.data.sessionId);
        } catch {
          ws.close();
          return;
        }
```

with:

```ts
      async open(ws: ServerWebSocket<WsData>) {
        let session;
        try {
          session = await connectAuthenticatedSession(ws.data.sessionId);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logMsg(getLogger(), "warn", "server.attach_failed", {
            sessionId: ws.data.sessionId,
            reason,
          });
          try {
            ws.send(JSON.stringify({ type: "error", message: reason }));
          } catch {
            // Socket may already be gone.
          }
          ws.close();
          return;
        }
```

`logMsg` and `getLogger` are already imported and used throughout
`src/server/server.ts` (e.g. line 214). `reason` is the `Error.message` from
`connectAuthenticatedSession`, which is non-sensitive (Bun `HandshakeError`
messages never include the credential/nonce, and the missing-sidecar case is a
plain instruction string).

- [ ] **Step 2: Add the `server.attach_failed` catalog key**

Run: `bun run messages:extract`
Then fill the scaffolded entry in `src/i18n/messages.en.json` (keep the generated
`id`):

```json
  "server.attach_failed": {
    "id": "<keep-generated-id>",
    "t": "attach failed for session {sessionId}: {reason}",
    "hint": "Warning logged when the dashboard server could not open an authenticated IPC connection to a session's daemon or proxy for a browser attach; {sessionId} is the local session ID and {reason} is a short non-sensitive failure description shown to the user.",
    "params": {
      "sessionId": { "redact": false, "category": "generic" },
      "reason": { "redact": false, "category": "generic" }
    }
  },
```

- [ ] **Step 3: Verify catalog + typecheck**

Run: `bun run messages:check && bun run typecheck`
Expected: `messages:check OK` and no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/server.ts src/i18n/messages.en.json
git commit -m "feat(server): surface attach failures to the browser via a JSON error frame"
```

---

## Task 3: Render the attach error as a red xterm line

**Files:**
- Modify: `src/web/components/TerminalView.tsx` (`ws.onmessage` string branch, ~lines 830-882)

- [ ] **Step 1: Extend the parsed message type and add the `error` case**

In `src/web/components/TerminalView.tsx`, extend the parsed type (~line 832) with
an optional `message`:

```ts
          const msg = JSON.parse(ev.data) as {
            type: string;
            exitCode?: number;
            cols?: number;
            rows?: number;
            controllerId?: string;
            message?: string;
          };
```

Add an `else if` branch after the `msg.type === "replay"` block (before the
closing `}` of the string-branch `try`):

```ts
          } else if (msg.type === "error") {
            const detail = typeof msg.message === "string" ? msg.message : "connection failed";
            term.write(`\r\n\x1b[31mclimon: cannot attach — ${detail}\x1b[0m\r\n`);
          }
```

The `error` control message is a string frame, so it is handled in the string
branch alongside `exit`/`size`/`control`/`replay` — it is not gated by the
binary replay/first-frame logic, so it always renders.

- [ ] **Step 2: Typecheck + build the web bundle**

Run: `bun run typecheck && bun run build:web`
Expected: no TypeScript errors; web build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/web/components/TerminalView.tsx
git commit -m "feat(web): render attach-error control frame as a red terminal line"
```

---

## Task 4: Docs — security note + manual test

**Files:**
- Modify: `docs/security.md`
- Create: `docs/manual-tests/remote-attach-auth.md`
- Modify: `docs/manual-tests/README.md` (add to the "Cases by phase" index)

- [ ] **Step 1: Add the security note**

Open `docs/security.md`, find the section covering session IPC / CWE-306 /
authenticated IPC (grep for `CWE-306` or `ipc-auth`), and add:

```markdown
Remote (devbox) sessions materialized by the Rust ingest now use the same
authenticated loopback IPC as local sessions: the ingest mints a per-session
`<id>.ipc-auth` credential (endpoint = the resolved loopback proxy ref) and runs
the daemon side of the mutual-HMAC handshake on every inbound browser proxy
connection before bridging any bytes to the devbox. An unauthenticated connection
to the loopback proxy is dropped and never triggers an `attach`, closing the
CWE-306 gap for the remote proxy hop.
```

- [ ] **Step 2: Create the manual test file**

Create `docs/manual-tests/remote-attach-auth.md`:

```markdown
# Remote session attach authentication

Verifies that remote (devbox) sessions render in the dashboard terminal via the
authenticated loopback IPC proxy, and that attach failures are visible.

## RAA-1 — Remote terminal renders

**Feature:** Authenticated Rust ingest proxy for remote sessions
(`rust/climon-remote/src/ingest.rs`, `rust/climon-session/src/auth.rs`).

**Preconditions:** A devbox uplink connected to a local dashboard server over a
dev tunnel (or WSL↔Windows direct link), with at least one live remote session.

**Steps:**
1. Open the dashboard and locate a remote (namespaced `label~id`) session.
2. Click the session to open its terminal.
3. Type a command in the terminal and observe output.

**Expected result:** The terminal renders live PTY output (not blank). The devbox
uplink log shows an `attach` line for the session. Keystrokes reach the devbox and
output streams back.

**Platforms:** macOS/Linux/Windows dashboard; devbox on Linux/WSL.

**Result tracking:**

| Date | Version | Tester | Platform | Pass/Fail | Notes |
|---|---|---|---|---|---|

## RAA-2 — Attach failure is visible

**Feature:** Observable attach failure
(`src/server/server.ts`, `src/web/components/TerminalView.tsx`).

**Preconditions:** As RAA-1.

**Steps:**
1. On the dashboard host, delete or corrupt the remote session's
   `~/.climon/sessions/<label~id>.ipc-auth` file (e.g. truncate it to `{`).
2. In the dashboard, open (or reopen) that session's terminal.

**Expected result:** The terminal shows a red line
`climon: cannot attach — …`, and the server log records a
`server.attach_failed` warning with the session id. The tab does not silently
blank.

**Platforms:** macOS/Linux/Windows dashboard.

**Result tracking:**

| Date | Version | Tester | Platform | Pass/Fail | Notes |
|---|---|---|---|---|---|
```

- [ ] **Step 3: Link it from the index**

In `docs/manual-tests/README.md`, add a row to the "Cases by phase" table
(in the `| — |` section):

```markdown
| — | Remote session attach authentication — authenticated Rust ingest proxy + visible attach errors | [remote-attach-auth.md](remote-attach-auth.md) |
```

- [ ] **Step 4: Commit**

```bash
git add docs/security.md docs/manual-tests/remote-attach-auth.md docs/manual-tests/README.md
git commit -m "docs: document authenticated remote attach IPC and add manual checks"
```

---

## Task 5: Full verification

- [ ] **Step 1: Rust build, tests, clippy, fmt**

Run: `cd rust && cargo build --workspace && cargo test -p climon-remote && cargo clippy -p climon-remote --all-targets && cargo fmt --check`
Expected: PASS. (Run `cargo fmt` if `--check` reports diffs, then re-commit.)

- [ ] **Step 2: Bun typecheck + catalog + targeted web/server tests**

Run: `bun run typecheck && bun run messages:check`
Expected: no errors; `messages:check OK`.

- [ ] **Step 3: Bun web/server test sanity (tolerate known flakes)**

Run: `bun test tests/terminal-panel.test.ts`
Expected: PASS in isolation. (Per repo memory, some TerminalPanel/refit tests only
fail under full-suite ordering; run this file alone to confirm no new regression.)

- [ ] **Step 4: Manual smoke (if a devbox is available)**

Follow `docs/manual-tests/remote-attach-auth.md` RAA-1 and RAA-2 against a real
devbox uplink: confirm a remote terminal renders and that removing the sidecar
produces the red error line.

---

## Self-review checklist (completed at authoring time)

- **Spec coverage:** sidecar mint/write + handshake gate in the Rust ingest
  (Task 1) ✓; sidecar removal on all teardown paths (Task 1, Step 5) ✓; server
  observable failure (Task 2) ✓; web red line (Task 3) ✓; docs security + manual
  test (Task 4) ✓.
- **Redirect recorded:** the fix moved from the frozen Bun `src/remote/ingest.ts`
  to the production Rust ingest; the Bun dashboard server already speaks the
  client handshake, so no Bun handshake/mint code is added.
- **Type consistency:** `RemoteSession.credential: Vec<u8>` is produced by
  `record.credential_bytes()` and consumed by `daemon_handshake(&mut _, &[u8])`;
  the accept-loop reader/writer bodies are unchanged; `parse_session_socket_ref`
  returns `ParsedRef::Tcp { host, port }` used by the test.
- **No placeholders:** every code step is complete; the only deferred values are
  the `messages:extract`-generated catalog `id` (keep as generated) and the mux
  decode/match variant names in the test, which must be reconciled against
  `rust/climon-remote/src/mux.rs` while writing the test.
