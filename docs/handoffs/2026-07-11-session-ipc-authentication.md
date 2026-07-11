> [!IMPORTANT]
> Before planning or changing code, invoke the `brainstorming` skill and discuss
> the proposed remediation with the user. Do not treat this handoff as approval
> to implement without that conversation.

# Security handoff: session IPC authentication

- **Date:** 2026-07-11
- **Audited commit:** `34a8169840ed6d4320517b78b6511f530cf8af8d`
- **Branch:** `security/session-ipc-authentication`
- **Worktree:** `/Users/jackallan/dev/climon/.worktrees/security-session-ipc-authentication`
- **Severity:** **HIGH**
- **CWE:** **CWE-306 — Missing Authentication for Critical Function**
- **Affected platforms:** macOS, Linux (including WSL), and Windows
- **Status:** Confirmed at the audited commit; remediation is designed below but
not implemented. Existing running daemons remain exposed until replaced or
restarted with an authenticated implementation.

## Executive summary

The per-session daemon is a privileged local trust boundary: it owns the victim's
PTY, buffered terminal output, control state, and command input. At the audited
commit, new sessions advertise and listen on unauthenticated loopback TCP
endpoints. Loopback limits reachability to the machine, but it does not identify
the connecting OS user or process.

Any local user or process able to reach localhost can discover a session endpoint
from readable metadata where permissions allow, enumerate loopback ports, or
recognize the frame protocol. A connection is immediately registered as a
dashboard surface. After a 10 ms timer, the daemon sends `PtySize`, replayed
terminal contents, and control state without authentication. The peer may also
send operational frames before any identity or authorization check.

A realistic exploit is:

1. Find `tcp://127.0.0.1:<port>` in session metadata or scan localhost.
2. Connect and receive terminal replay, exposing commands, output, paths, tokens
   printed to the terminal, or other session data.
3. Send `Resize` with an attacker-controlled viewer ID, then `TakeControl`.
4. Send `Input` to the victim PTY after becoming controller. The attacker can
   resize or disrupt the terminal, request further replay, acknowledge attention,
   and act through the victim's interactive command session.

The controller check on `Input` is not authentication. An unauthenticated peer
can create a surface identity and use `TakeControl` to satisfy that check.

## Current evidence and code map

Line ranges below are verified against audited commit
`34a8169840ed6d4320517b78b6511f530cf8af8d`.

### Transport and unauthenticated acceptance

- `rust/climon-session/src/socket.rs:14-22` defines session references as TCP or
  Unix paths.
- `rust/climon-session/src/socket.rs:28-82` formats and parses
  `tcp://host:port`.
- `rust/climon-session/src/socket.rs:101-168` accepts TCP/Unix streams and binds
  them without owner validation or authentication.
- `rust/climon-session/src/socket.rs:225-265` connects and declares readiness
  after transport connection alone.
- `rust/climon-session/src/socket.rs:267-358` tests raw TCP/Unix connectivity,
  not peer identity or authentication.

### Replay and operational frames before authentication

- `rust/climon-session/src/host.rs:618-663`
  (`write_replay`, `write_initial_frames`) queues `PtySize`, `Replay`, and
  `Control` for a newly registered client.
- `rust/climon-session/src/host.rs:854-872` binds the metadata-provided endpoint,
  publishes the resolved reference, and starts the accept thread.
- `rust/climon-session/src/host.rs:1053-1110` (`spawn_accept_thread`) registers
  every accepted stream as a dashboard client and starts the 10 ms initial-frame
  timer before any authentication.
- `rust/climon-session/src/host.rs:1147-1248`
  (`spawn_connection_reader`) accepts `Input`, `Resize`, `TakeControl`,
  `Attention`, and `Replay` directly from the stream.
- `rust/climon-session/src/host.rs:961` removes only filesystem socket paths at
  normal listener cleanup.

### Frame protocol

- `rust/climon-proto/src/frame.rs:12-45` defines the operational frame tags,
  including `Input`, `Resize`, `Replay`, `Attention`, `Control`, and
  `TakeControl`; there are no authentication frames.
- `rust/climon-proto/src/frame.rs:116-186` implements the length-prefixed codec.
  The current decoder has no explicit maximum advertised payload length.
- `rust/climon-proto/src/frame.rs:189-362` contains the codec unit tests that
  must be extended for authentication and bounds.

### Local launcher and attach client

- `rust/climon-cli/src/launcher.rs:502-537` creates foreground metadata with
  `tcp://127.0.0.1:0`.
- `rust/climon-cli/src/spawn.rs:108-161` does the same for detached/headless
  sessions before spawning the daemon.
- `rust/climon-cli/src/client.rs:404-433` (`connect_to_session`) connects and
  immediately sends `Resize`.
- `rust/climon-cli/src/client.rs:446-487` consumes daemon output/replay and can
  request another replay.
- `rust/climon-cli/src/client.rs:489-595` sends `Input`, `Resize`, and
  `TakeControl` with no handshake.

### Dashboard bridge and liveness probes

- `src/session-socket.ts:19-70` parses, connects to, and probes TCP/path
  references using transport connectivity only.
- `src/server/server.ts:855-901` (`probeSocket`, `shouldMarkDisconnected`) treats
  an unauthenticated connection as proof that a local daemon is live.
- `src/server/server.ts:2007-2055` loads `socketPath` from metadata and opens the
  daemon connection for a browser WebSocket.
- `src/server/server.ts:2056-2099` forwards browser `input`, `resize`,
  `takeControl`, `attention`, and `replay` messages to that unauthenticated
  connection.
- `tests/session-socket.test.ts:1-36` covers the current transport-only probe and
  connect behavior.

### Remote uplink

- `rust/climon-remote/src/uplink.rs:258-285` (`connect_session_pair`) opens raw
  TCP or Unix streams to a local session daemon.
- `rust/climon-remote/src/uplink.rs:374-420` (`attach`) reads `socket_path`,
  connects, and bridges raw daemon bytes to the remote mux without local IPC
  authentication.

### Metadata and file permissions

- `rust/climon-proto/src/meta.rs:105-160` defines `SessionMeta`; `socket_path` is
  public metadata and there is no IPC protocol-version field.
- `rust/climon-proto/src/meta.rs:162-205` allows `socket_path` patches.
- `src/types.ts:195-200` documents new sessions as loopback TCP references.
- `rust/climon-store/src/meta.rs:121-167` atomically writes, reads, and lists
  session metadata.
- `rust/climon-store/src/atomic.rs:105-130` uses `fs::write` and rename but does
  not explicitly set owner-only file permissions.
- `rust/climon-store/src/meta.rs:170-186` removes metadata/scrollback but has no
  credential sidecar to clean up.
- `rust/climon-store/src/paths.rs:43-65` defines the sessions and socket
  directories.
- `src/config.ts:72-109` defines `sessions`, `sock`, and platform socket paths.
- `docs/architecture.md:24-35,51-112,305-311` describes the daemon/socket flow
  and the intended POSIX socket/Windows pipe layout.

### Existing integration coverage

- `rust/climon-session/tests/session_integration.rs:79-100` deliberately uses
  loopback TCP for session tests.
- `rust/climon-session/tests/session_integration.rs:155-239` expects initial
  replay immediately after connecting.
- `rust/climon-session/tests/session_integration.rs:274-322` sends unauthenticated
  resize.
- `rust/climon-session/tests/session_integration.rs:324-403` sends
  unauthenticated attention acknowledgement.
- `rust/climon-session/tests/session_integration.rs:405-498` continues the
  resize/attention lifecycle coverage that must be migrated to authenticated
  helpers.

## Approved architecture

Use a hybrid, defense-in-depth design:

1. **Unix:** owner-restricted Unix domain sockets are the default on macOS,
   Linux, and WSL.
2. **Windows:** named pipes with an explicit same-user DACL are the default.
3. **TCP:** authenticated loopback TCP is supported only as an explicit fallback;
   it is never selected silently after a local-transport failure.
4. **Every transport:** a mandatory per-session CSPRNG credential and a
   versioned challenge-response handshake complete before replay, registration as
   a surface, or acceptance of any operational frame.

Transport permissions and the application handshake are both required. The
credential protects the explicit TCP fallback and catches permission or ACL
mistakes. Owner-restricted transports reduce exposure before application parsing
and provide a second independent boundary.

## Security invariants

The implementation is complete only if all of these remain true:

1. A transport connection is not an authenticated session client.
2. Before authentication, the daemon sends only a bounded authentication
   challenge. It sends no PTY size, replay, output, title, attention, control, or
   exit state.
3. Before authentication, the daemon ignores/rejects every operational frame,
   including `Resize`, `TakeControl`, `Input`, `Replay`, and `Attention`.
4. A peer is inserted into `HostState.clients`, assigned a viewer identity, or
   considered for control only after successful authentication.
5. Every production consumer authenticates: readiness probes, local attach,
   dashboard bridge, remote uplink, reconnects, and tests.
6. Authentication is mandatory on Unix sockets and named pipes as well as TCP.
7. Missing, unreadable, malformed, stale, or wrong credentials fail closed.
8. Old clients and old daemons are never silently accepted as unauthenticated
   compatibility peers.
9. Secrets never enter `SessionMeta`, browser/API responses, remote metadata,
   mux control messages, command lines, environment dumps, errors, telemetry, or
   logs.
10. Endpoint references are non-secret. Security must not depend on a hidden
    path or port.

## Credential lifecycle and storage

### Generation and representation

- Generate a fresh 32-byte credential with the OS CSPRNG (`getrandom` is already
  a workspace dependency).
- Generate it in the daemon/session-host immediately before listener startup,
  including every daemon restart or rebind. Do not derive it from session ID,
  PID, timestamp, port, hostname, or install ID.
- Keep the binary credential in memory. If a textual sidecar representation is
  needed, use fixed-length lowercase hex or unpadded base64 and reject all other
  lengths/encodings.

### Private sidecar, not public metadata

Store the credential at
`$CLIMON_HOME/sessions/<id>.ipc-auth`, derived from the already-validated session
ID. Do **not** add the credential to `SessionMeta`: metadata is serialized to the
dashboard and remote flows, while the dashboard server and local uplink can read
an owner-only local sidecar directly.

The sidecar write must be atomic and owner-only:

- Unix: `$CLIMON_HOME`, `sessions`, and `sock` are `0700`; metadata and
  credential files are `0600`; the final socket node is `0600`. Verify the
  effective mode and owner after creation. Treat inability to establish or verify
  permissions as a startup failure.
- Windows: apply an explicit DACL granting the current user SID the required
  access. Do not grant `Everyone`, `Users`, or `Authenticated Users`. Apply the
  same owner-only policy to metadata and the credential sidecar.
- Atomic temporary files must receive restrictive permissions before data is
  written and retain them through rename. Do not rely on the caller's umask.

The daemon writes/rotates the sidecar before binding, binds with authentication
already required, then patches the resolved endpoint and public IPC protocol
version into metadata. Consumers encountering a transient old credential during
rotation may reload and retry within the bounded readiness window; they must
never downgrade.

### Cleanup

- Remove the credential sidecar after the listener has stopped and all
  connection threads have exited.
- Session removal and stale-session cleanup also remove orphaned sidecars and
  filesystem sockets.
- A crash may leave a sidecar, but a later daemon start always rotates it before
  advertising a new endpoint. A stale sidecar alone must not authenticate to any
  live daemon.
- Never remove or rotate the credential while a live listener still expects the
  old value unless the listener and all consumers are intentionally restarted as
  one fail-closed transition.

## Versioned authentication handshake

Use new protocol tags after the existing operational range; do not reuse reserved
tags 9 or 10. A concrete initial allocation is:

- `AuthChallenge = 13`
- `AuthResponse = 14`
- `AuthOk = 15`
- `AuthError = 16`

Treat the allocation as wire protocol and lock it with Rust/TypeScript parity
tests.

Protocol version 1:

1. Server accepts the transport into a **pre-auth** state. It does not create a
   `Client`.
2. Server generates a fresh 32-byte nonce and sends this camel-case JSON
   `AuthChallenge`:
   `{"version":1,"sessionId":"<id>","serverNonce":"<64 lowercase hex>"}`.
3. Client verifies the expected version and session ID, generates a fresh
   32-byte client nonce, and returns this camel-case JSON `AuthResponse`:
   `{"version":1,"clientNonce":"<64 lowercase hex>","mac":"<64 lowercase hex>"}`.
4. Server validates shape and lengths, computes the expected MAC, and verifies it
   using the HMAC library's constant-time verification API.
5. Server sends `AuthOk` as `{"version":1}`, then and only then registers the
   client and permits operational frames. The client sends no operational frame
   until `AuthOk`.

Use HMAC-SHA-256 keyed by the raw 32-byte per-session credential. Define its
transcript byte-for-byte as:

```text
b"climon-session-ipc-v1\0"
|| version as u16 big-endian
|| UTF-8 session-id length as u16 big-endian
|| UTF-8 session-id bytes
|| 32 raw server-nonce bytes
|| 32 raw client-nonce bytes
```

Send the full 32-byte HMAC-SHA-256 tag without truncation. Encode each nonce and
the tag as exactly 64 lowercase ASCII hex characters on the wire; reject
uppercase, non-hex, odd-length, shortened, or extended values. Rust and Bun must
decode those fields to the same raw bytes and produce byte-for-byte identical
transcript and tag bytes for shared fixed test vectors.

The server nonce prevents replaying a captured response on a later connection;
credential rotation prevents reuse across daemon incarnations. Domain separation
prevents accidental cross-protocol use. Do not log nonces, response MACs, or the
credential.

Authentication failure should produce at most one generic, bounded `AuthError`
and close the stream. Do not reveal whether the session, credential file, version,
or MAC was wrong. User-facing callers may map the local failure to a concise
"session IPC authentication failed or is incompatible" error.

### Bounds, timeouts, and resource control

- Complete authentication within a short fixed deadline (recommended: 3
  seconds). Enforce read and write timeouts during the handshake.
- Cap each authentication payload at 4 KiB and require exact nonce/MAC lengths.
- Add an explicit maximum frame payload to the shared decoder: 4 KiB while
  unauthenticated and 8 MiB after authentication. Reject the length prefix before
  allocating or buffering the advertised payload.
- Limit concurrent unauthenticated handshakes (recommended initial cap: 32 per
  daemon). A slow peer must not block the accept loop or consume unbounded
  threads/memory.
- Allow one authentication response per connection. Malformed, duplicate,
  out-of-order, unknown-version, oversized, or timed-out handshakes close.
- Existing 5-second socket write limits may remain for authenticated operational
  traffic, but authentication has its own shorter deadline.

## Transport selection

### Unix default

Use `$CLIMON_HOME/sock/<id>.sock`. Create and verify the owner-only directory,
remove only a socket belonging to this session, bind, set/verify `0600`, then
publish the path. Where available, verify the connected peer UID as an additional
defense; a peer-credential check does not replace the handshake.

Account for Unix socket path limits. If the configured home makes the path too
long, return a clear error with remediation. Do not silently switch to TCP.

### Windows default

Use `\\.\pipe\climon-<id>` with a security descriptor built from the current user
SID. Reject remote pipe clients and do not use a default permissive DACL. The
listener/stream abstraction must support the same clone/read/write/shutdown and
timeout semantics expected by `SessionStream`.

### Explicit TCP fallback

Introduce the global-only setting
`session.ipcTransport = "local" | "tcp"` through the normal config registries,
defaulting to `"local"`. `"local"` means Unix socket or Windows named pipe and
fails if that transport cannot be secured. `"tcp"` binds only a verified
loopback address and still requires the full credential handshake.

Do not use an `"auto"` mode that silently falls back. Reject non-loopback TCP
hosts. If this setting is adopted, update both Rust/TypeScript config registries,
golden fixtures, generated config docs, and global-only enforcement.

## Consumers and flows that must migrate together

Partial migration will either break features or reintroduce an unauthenticated
path. Update these as one coordinated change:

- Foreground launcher/session-host startup.
- Detached/headless launcher, metadata creation, and daemon spawn.
- Transport selection, bind, resolved-endpoint publication, sidecar rotation,
  and listener cleanup.
- Socket readiness wait and liveness probes; success means a completed handshake,
  not a successful connect.
- Local attach and reconnect, including initial resize.
- Dashboard server WebSocket bridge and daemon liveness cleanup probe.
- Remote uplink local-session attach and detach.
- Initial `PtySize`/`Replay`/`Control`, explicit replay requests, and live output.
- `Resize`, `TakeControl`, `Input`, `Attention`, and all future operational
  frames.
- Detach/reconnect and controller fallback when an authenticated connection
  closes.
- Rust and TypeScript metadata serialization/parity, including a non-secret
  `ipcProtocolVersion` field.
- Session deletion, stale cleanup, normal final cleanup, and crash recovery.
- Unix/macOS/Linux/WSL and Windows transport tests.

The browser must never receive the sidecar credential. The Bun dashboard server
authenticates its daemon-side connection and continues translating the existing
browser WebSocket protocol.

## Migration and backward compatibility

This is a deliberate fail-closed protocol break:

- New daemons reject a first operational frame from an old client.
- New clients reject an old daemon that does not send a valid challenge.
- New readiness probes do not call an old unauthenticated endpoint "ready".
- Missing `ipcProtocolVersion` on a live session is treated as legacy and
  unsupported, not as permission to skip authentication.
- Do not add a timeout-based, version-based, config-based, or transport-based
  unauthenticated downgrade.

Release the updated Rust client and Bun server together. The upgrade flow should
restart the dashboard server and clearly tell users to restart/recreate active
sessions. Existing daemons cannot be secured in place by changing only metadata;
they remain vulnerable until stopped.

If a short migration window is operationally necessary, isolate it by release
coordination and user-visible errors, not by accepting old unauthenticated peers.
Completed sessions remain readable from persisted scrollback and do not need a
live IPC credential.

## Implementation decomposition

1. **Protocol primitives (`climon-proto` and TypeScript frame parity).**
   Add authentication tags/payloads, version constants, strict parsing, and frame
   size limits.
2. **Secure storage (`climon-store` and Bun store/config helpers).**
   Add sidecar paths, CSPRNG create/rotate/read/delete helpers, owner-only atomic
   writes, directory/metadata permission enforcement, and non-secret metadata
   protocol versioning.
3. **Transport abstraction (`climon-session::socket`).**
   Implement Unix default, Windows named-pipe backend with same-user ACL, explicit
   authenticated TCP fallback, cleanup, timeouts, and platform-specific tests.
4. **Daemon pre-auth state (`climon-session::host`).**
   Authenticate before client registration/timers/readers, bound pre-auth
   concurrency, then preserve existing replay/control behavior after `AuthOk`.
5. **Rust local consumers (`climon-cli`).**
   Make wait/probe/attach load the sidecar and complete the handshake before
   resize or input.
6. **Bun dashboard consumer.**
   Authenticate both liveness probes and WebSocket bridge connections without
   exposing the credential to browser data.
7. **Remote uplink consumer.**
   Authenticate its local daemon connection before forwarding any bytes over the
   mux.
8. **Cleanup and migration UX.**
   Remove sidecars, detect legacy metadata/daemons, and return actionable
   incompatibility errors.
9. **Documentation and cross-platform verification.**
   Update security/architecture/features/config/manual-test material and run all
   completion gates.

## Ordered TDD plan

Write each failing test before its production change.

1. In `rust/climon-proto/src/frame.rs`, add Rust/Bun parity tests for tags 13-16,
   round-trips, malformed payloads, unknown versions, oversized frames, and fixed
   HMAC-SHA-256 vectors proving byte-for-byte transcript, full 32-byte tag, and
   lowercase-hex wire-encoding parity.
2. In `rust/climon-store/src/meta.rs` and a focused new authentication-storage
   module/test, prove 32-byte CSPRNG output, atomic rotation, exact parsing,
   owner-only Unix modes, metadata mode repair, and sidecar cleanup. Add Windows
   ACL tests behind `cfg(windows)`.
3. In `rust/climon-session/src/socket.rs`, first prove default Unix selection,
   path-length failure, no silent TCP fallback, loopback-only TCP validation, and
   Windows named-pipe ACL construction/connection.
4. In `rust/climon-session/tests/session_integration.rs`, add the primary
   security regressions:
   - unauthenticated connect receives no replay;
   - pre-auth `Resize`, `TakeControl`, `Input`, `Attention`, and `Replay` are
     rejected and do not affect the PTY/session;
   - wrong, malformed, replayed, oversized, timed-out, and old-version handshakes
     close;
   - correct authentication yields initial frames and preserves existing
     resize/control/input/replay behavior;
   - credential rotation invalidates the old credential;
   - unauthenticated-connection limits recover after close/timeout.
5. In `rust/climon-cli/src/client.rs` and focused CLI integration coverage, prove
   no initial resize is sent before `AuthOk`, detach/reconnect reauthenticates, and
   old/missing credentials fail closed with a useful error.
6. In `tests/session-socket.test.ts`, replace transport-only readiness expectations
   with authenticated readiness. Add `tests/session-ipc-auth.test.ts` for Bun
   handshake parity, liveness probes, and the dashboard bridge.
7. In `rust/climon-remote/src/uplink.rs` tests, prove local attach authenticates
   before any mux data, failure does not advertise an attached stream, and
   detach/reconnect performs a new handshake.
8. Add platform integration tests for Unix socket ownership/modes and Windows
   pipe same-user allow/different-user deny behavior.
9. Only after focused tests pass, run the wider workspace and Bun suites.

Likely focused commands:

```sh
cd rust
cargo test -p climon-proto frame
cargo test -p climon-store
cargo test -p climon-session socket
cargo test -p climon-session --test session_integration
cargo test -p climon-cli client
cargo test -p climon-remote uplink

cd ..
bun test tests/session-socket.test.ts tests/session-ipc-auth.test.ts
```

Final automated gates:

```sh
cd rust
cargo fmt --check
cargo clippy --all-targets
cargo test

cd ..
bun run typecheck
bun test tests
```

## Manual verification

Add a dedicated manual-test document and index entry. At minimum verify:

### macOS

- A normal session uses a Unix socket, not TCP.
- Home/socket/session modes are owner-only.
- Dashboard attach, local attach/reconnect, replay, resize, take-control, input,
  detach, and final cleanup still work.
- A second OS user cannot connect or read the sidecar.
- Explicit TCP fallback works only when configured and rejects a wrong credential.

### Linux and WSL

- Repeat the macOS cases on a native Linux filesystem.
- Verify peer UID/mode behavior and stale socket cleanup.
- Verify WSL path-length and mounted-filesystem errors fail clearly rather than
  silently falling back.
- Verify remote uplink can still attach to a local daemon through the final
  authenticated IPC API.

### Windows

- A normal session uses the named pipe.
- Inspect the pipe DACL: current user allowed; unrelated local user denied; no
  broad user group granted.
- Verify dashboard/local attach, replay, resize, take-control, input,
  detach/reconnect, and cleanup.
- Verify explicit loopback TCP fallback and wrong-credential rejection.

### Upgrade/failure cases

- New client to old daemon fails with an incompatibility/authentication error.
- Old client/dashboard to new daemon receives no replay and cannot operate it.
- Missing/unreadable sidecar, bad permissions/ACL, unsupported version, timeout,
  and oversized handshake all fail closed.
- Logs, errors, process arguments, browser network payloads, metadata JSON,
  telemetry, and remote mux captures contain no credential.

## Required documentation updates during implementation

- `docs/security.md`: add the local session IPC threat model, owner-restricted
  transports, credential sidecar, handshake, fail-closed migration, and residual
  same-user trust limitations.
- `docs/architecture.md`: update the transport/data-flow diagram, daemon startup,
  protocol framing, metadata/sidecar layout, and platform transport table.
- `docs/features.md`: update the existing client/session IPC feature row or add
  the next factual in-development security feature entry, following the
  catalogue rules.
- `docs/manual-tests/README.md`: link a new security session-IPC manual test.
- `docs/manual-tests/security-session-ipc-authentication.md`: include the
  Unix/macOS/Linux/WSL/Windows, fallback, upgrade, and negative cases above.
- If a transport config setting is added, update `src/config-settings.ts`,
  Rust parity, fixtures via `bun scripts/gen-config-fixtures.ts`, and generated
  comments/docs via `bun run docs:config`.

## Paired remote-channel sequencing

The paired remote channel implementation must start **only after this session IPC
authentication work is completed and merged**. It must consume the final
authenticated IPC interface rather than duplicating the current raw
`socket_path` connection or designing against an interim API. This ordering
prevents the remote work from preserving an unauthenticated local hop or having
to migrate twice.

## Rejected weaker alternatives

### Transport permissions only

Unix modes and Windows ACLs are valuable but insufficient alone: permission
mistakes, unsupported filesystems, implementation drift, and TCP fallback would
reopen the boundary. Every transport still requires the handshake.

### Authenticated TCP everywhere

Authentication would fix the immediate missing-auth flaw, but TCP exposes the
parser and listener to every local user/process and loses OS-native owner
restriction. Use it only as explicit fallback, layered with authentication.

### Random or hidden ports

Port numbers are enumerable, appear in metadata, and are not credentials.
Security through port obscurity does not prevent replay theft or control.

### Metadata secrecy alone

Restrictive metadata permissions are required because metadata contains commands,
paths, and endpoints, but endpoint secrecy is not authentication. Metadata may
be observed, backed up, copied, or exposed by a permission regression. Keep the
credential in a separate owner-only sidecar and require proof of possession.

## Out of scope

- Redesigning browser authentication or dashboard Origin/Host authorization.
- Replacing or redesigning the remote ingest/uplink network protocol; that is the
  paired follow-up and must build on this result.
- Encrypting local PTY traffic. The requirement is authenticated local IPC;
  transport confidentiality against a fully privileged same-user debugger is not
  claimed.
- Protecting a session from root, Administrator, kernel compromise, or a process
  already running as the same user with permission to read the sidecar.
- Unrelated PTY, terminal rendering, control-priority, or remote-spawn changes.

## Risks and review focus

- **Partial consumer migration:** probes or uplink may accidentally retain a raw
  connection path.
- **Secret exposure:** adding the credential to `SessionMeta` would leak it to
  browser/remote serialization.
- **Replay race:** registering the client or starting the 10 ms timer before
  `AuthOk` preserves the vulnerability.
- **Permission assumptions:** `fs::write` plus umask is not enough; Windows
  default pipe ACLs are not enough.
- **Silent fallback:** Unix path-length or Windows pipe errors must not trigger
  implicit TCP.
- **Upgrade downgrade:** compatibility logic must not interpret missing challenge
  or missing version as legacy permission.
- **Resource exhaustion:** pre-auth peers need strict size/time/concurrency caps.
- **Wire parity:** Rust daemon, Rust clients, and Bun server must agree
  byte-for-byte on tags, payload encodings, version, HMAC-SHA-256 transcript, and
  the untruncated 32-byte tag/lowercase-hex representation.
- **Socket-path length:** `$CLIMON_HOME/sock/<id>.sock` can exceed Unix limits in
  deep test/worktree paths; error handling and test scratch locations matter.

## Completion gates

- All security invariants above are represented by automated tests.
- Unauthenticated connections receive no session data and cannot change PTY or
  session state on any transport.
- Unix owner/mode and Windows same-user ACL tests pass on their native platforms.
- Explicit TCP fallback is loopback-only, authenticated, documented, and never
  selected silently.
- Every listed consumer completes the same versioned handshake.
- New/old combinations fail closed without downgrade.
- Credential generation, rotation, permissions, redaction, and cleanup are
  verified.
- Focused tests, full Rust tests/clippy/format, Bun typecheck/tests, and manual
  platform checks pass.
- `docs/security.md`, `docs/architecture.md`, `docs/features.md`, config docs (if
  applicable), and manual tests are updated.
- The implementation receives security-focused review before merge.
- The paired remote-channel work has not started against an interim IPC API and
  begins only after this work is merged.
