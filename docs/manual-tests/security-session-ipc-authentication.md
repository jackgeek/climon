# Authenticated session IPC

Manual checks for the per-session daemon IPC authentication remediation
(CWE-306). Every session's daemon now listens on an owner-only local transport
by default (Unix domain socket on macOS/Linux/WSL, Windows named pipe with a
same-user DACL) or an explicit authenticated loopback TCP fallback, and gates
**all** IPC — local CLI attach, dashboard bridge, and remote uplink — behind a
versioned mutual HMAC-SHA-256 handshake keyed by a 32-byte CSPRNG credential in
an owner-only sidecar `$CLIMON_HOME/sessions/<id>.ipc-auth`.

See the remediation design in
[`docs/handoffs/2026-07-11-session-ipc-authentication.md`](../handoffs/2026-07-11-session-ipc-authentication.md)
and the implementation plan in
[`docs/superpowers/plans/2026-07-11-authenticated-session-ipc.md`](../superpowers/plans/2026-07-11-authenticated-session-ipc.md).

## Configuration matrix

| Dimension | Cells |
|---|---|
| Transport (`session.ipcTransport`, global-only) | `local` (default), `tcp` |
| Local transport backend | Unix domain socket (macOS/Linux/WSL), Windows named pipe |
| Consumer | Local CLI attach, dashboard (browser) bridge, remote uplink |
| Session provenance | Fresh (this build), legacy (pre-remediation binary, no sidecar) |

The cases below note which cell each exercises. Run SIPC-1..SIPC-6 on every
platform you ship; SIPC-7 (ownership) is cross-platform; SIPC-8 needs a remote
pairing; SIPC-9 is Windows-only; SIPC-10 is transport-agnostic.

---

## SIPC-1 — Default transport is owner-only local with a 0600 credential sidecar

- **ID:** SIPC-1
- **Feature / phase:** Authenticated session IPC — default transport + credential storage.
- **Preconditions:** A build containing this feature. A clean `$CLIMON_HOME`
  (or note existing sessions). A terminal.
- **Config-matrix cell:** Transport = `local` (default); backend = Unix socket
  (macOS/Linux/WSL) or Windows named pipe.
- **Platforms:** macOS, Linux, WSL, Windows.

**Steps:**
1. Start a session: `climon bash` (or any long-running command).
2. In a second terminal, read the session id from `climon ls` (or the printed
   dashboard URL).
3. Inspect the published endpoint in metadata:
   `cat "$CLIMON_HOME/sessions/<id>.json"` and look at `socketPath`.
4. Confirm the sidecar exists and its permissions:
   - macOS/Linux/WSL: `ls -l "$CLIMON_HOME/sessions/<id>.ipc-auth"`.
   - Windows (PowerShell): `Get-Acl "$env:CLIMON_HOME\sessions\<id>.ipc-auth" | Format-List`.
5. Inspect the sidecar contents:
   `cat "$CLIMON_HOME/sessions/<id>.ipc-auth"` (JSON with `version`,
   `generation`, `endpoint`, `credential`).
6. Confirm the metadata carries the non-secret coordination fields
   `ipcProtocolVersion` and `ipcGeneration`, and that `ipcGeneration` equals the
   sidecar's `generation`.

**Expected:** `socketPath` is a filesystem socket path (macOS/Linux/WSL, e.g.
`.../sock/<id>.sock`) or a `pipe://climon-<id>` reference (Windows) — **not** a
`tcp://` reference. The `.ipc-auth` file exists with mode `0600` on
macOS/Linux/WSL (owner read/write only) or an ACL granting only the current user
(+ SYSTEM/Administrators) on Windows. The sidecar's `credential` is 64 hex
characters; `version` is `1`. Metadata's `ipcProtocolVersion` is `1` and
`ipcGeneration` matches the sidecar `generation`. The credential value never
appears in `<id>.json`.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## SIPC-2 — Unauthenticated connection receives no PTY bytes and is dropped

- **ID:** SIPC-2
- **Feature / phase:** Authenticated session IPC — handshake gate on the daemon.
- **Preconditions:** A live session from SIPC-1; note its `socketPath`.
- **Config-matrix cell:** Consumer = raw socket client skipping the handshake;
  transport = `local` (repeat with `tcp` for full coverage).
- **Platforms:** macOS, Linux, WSL (Unix socket); Windows (named pipe).

**Steps:**
1. Connect to the endpoint without performing the handshake and immediately try
   to send an Input/Resize frame, then read:
   - Unix socket: `nc -U <socketPath>` (use the real `socketPath` from
     metadata); or a short script that opens the socket, writes an arbitrary
     Resize frame, and reads for 1s.
   - TCP (rerun with `session.ipcTransport = "tcp"`):
     `nc 127.0.0.1 <port>` then type bytes and observe.
2. Observe whether any bytes are received back.
3. Send >4 KiB of junk as the first frame's declared length and observe the
   connection.
4. Confirm the real session is unaffected: attach normally with
   `climon <id>` (or open its dashboard terminal) and verify live I/O.

**Expected:** The daemon completes (or attempts) the handshake first; because
the raw client cannot produce a valid `AuthResponse`, the daemon sends an
`AuthError` (or closes) and the connection is dropped. The raw client receives
**no** PTY output frames and its input never reaches the shell. An
oversized pre-auth frame (>4 KiB) is rejected and the connection closed. The
legitimate attach in step 4 works normally, proving the gate only blocks
unauthenticated peers.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## SIPC-3 — Dashboard attach works transparently; credential never reaches the browser

- **ID:** SIPC-3
- **Feature / phase:** Authenticated session IPC — Bun dashboard consumer.
- **Preconditions:** A live session and the dashboard server
  (`bun src/server.ts server` or the shipped `climon server`). Note the dashboard
  port and session id.
- **Config-matrix cell:** Consumer = dashboard (browser) bridge; transport =
  `local`.
- **Platforms:** Desktop Chrome/Firefox/Safari; also verify one PWA/mobile viewer.

**Steps:**
1. Open the dashboard at `http://127.0.0.1:<port>/` and open the session
   terminal. Type in the terminal and confirm live output both ways.
2. Open browser devtools → Network → the attach WebSocket. Inspect the WS
   frames/messages from the moment it connects.
3. Search the WS message stream and the page memory for the sidecar's
   `credential` hex value (from SIPC-1) and for any `Auth*` frame tags (13–17).
4. Confirm the dashboard session-list shows the session as live (the server's
   liveness probe now authenticates).

**Expected:** The dashboard terminal attaches and streams normally — the
server transparently loads the credential and completes the handshake before
bridging. The browser WebSocket carries **only** post-auth frames: the
credential hex is never present in any WS message or in page memory, and no
`AuthChallenge/AuthResponse/AuthOk` frames are forwarded to the browser. The
session shows as live in the list.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## SIPC-4 — TCP fallback still requires authentication

- **ID:** SIPC-4
- **Feature / phase:** Authenticated session IPC — authenticated TCP fallback.
- **Preconditions:** Set the global-only setting
  `climon config set session.ipcTransport tcp --global`. Start a fresh session
  (the setting is read at daemon start).
- **Config-matrix cell:** Transport = `tcp`.
- **Platforms:** macOS, Linux, WSL, Windows.

**Steps:**
1. Confirm the new session's `socketPath` is a `tcp://127.0.0.1:<port>`
   reference in `<id>.json`.
2. Attach normally with `climon <id>` and via the dashboard — confirm both work.
3. From a raw client, connect to `127.0.0.1:<port>` and attempt to send
   input/read output without handshaking (as in SIPC-2).
4. Restore the default afterwards:
   `climon config set session.ipcTransport local --global` (or unset it).

**Expected:** With `tcp` selected the endpoint is loopback TCP, but the mutual
handshake is still mandatory: legitimate CLI and dashboard attach succeed, while
a raw unauthenticated TCP client is rejected and receives no PTY bytes. Setting
`session.ipcTransport` at a project-local scope is refused (global-only).

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## SIPC-5 — Legacy session (no sidecar) fails closed with an actionable message

- **ID:** SIPC-5
- **Feature / phase:** Authenticated session IPC — fail-closed migration UX.
- **Preconditions:** A session whose daemon has **no** `.ipc-auth` sidecar,
  simulating one started by a pre-remediation binary. Reproduce by either
  (a) attaching to a session created by an older `climon` build, or
  (b) with a live current session, deleting its sidecar:
  `rm "$CLIMON_HOME/sessions/<id>.ipc-auth"` (Windows:
  `Remove-Item "$env:CLIMON_HOME\sessions\<id>.ipc-auth"`).
- **Config-matrix cell:** Session provenance = legacy (no sidecar).
- **Platforms:** macOS, Linux, WSL, Windows.

**Steps:**
1. Attempt to attach from the CLI: `climon <id>`.
2. Open the session from the dashboard.
3. Read the error text surfaced in each consumer.
4. Recover: stop and restart the session with the current build; confirm a new
   sidecar is created and attach now works (repeat SIPC-1 step 4).

**Expected:** Both the CLI attach and the dashboard bridge **refuse** to connect
(fail closed — they never fall back to an unauthenticated connection). The error
clearly states the session was started by an older/unauthenticated climon and
must be stopped and restarted to enable authenticated IPC (message contains
"restart"). After restarting, a sidecar exists and attach succeeds.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## SIPC-6 — Cleanup removes orphaned credential sidecars and ownership locks

- **ID:** SIPC-6
- **Feature / phase:** Authenticated session IPC — generation-aware cleanup.
- **Preconditions:** At least one dead/terminal session whose daemon has exited.
- **Config-matrix cell:** Transport = `local` (also valid for `tcp`).
- **Platforms:** macOS, Linux, WSL, Windows.

**Steps:**
1. Start a session, then terminate its daemon uncleanly (e.g. `kill -9` the
   daemon pid from `<id>.json` `daemonPid`, or power-cycle scenario) so the
   `.ipc-auth` sidecar and `.ipc-lock/` directory are left behind.
2. Confirm both artifacts remain:
   `ls -la "$CLIMON_HOME/sessions/" | grep <id>` (look for `<id>.ipc-auth` and
   `<id>.ipc-lock`).
3. Run `climon cleanup`.
4. Re-list the sessions directory.

**Expected:** `climon cleanup` prunes the dead session and removes both its
`<id>.ipc-auth` sidecar and its `<id>.ipc-lock/` directory. Live sessions and
their artifacts are untouched. Cleanup validates ids and never touches files
outside `$CLIMON_HOME/sessions`.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## SIPC-7 — Exclusive daemon ownership: a second daemon for the same id fails fast

- **ID:** SIPC-7
- **Feature / phase:** Authenticated session IPC — exclusive ownership guard +
  bind-before-publish.
- **Preconditions:** A live session with a known id.
- **Config-matrix cell:** Transport = `local` (and `tcp`).
- **Platforms:** macOS, Linux, WSL, Windows.

**Steps:**
1. With the session live, confirm `$CLIMON_HOME/sessions/<id>.ipc-lock/` exists.
2. Attempt to start a second daemon for the same id directly:
   `climon __session <id>` in another terminal.
3. Observe the second process's exit/behaviour and that the original session
   keeps working.
4. On Windows only, additionally confirm the named pipe cannot be hijacked:
   a second `climon __session <id>` cannot create a first pipe instance.

**Expected:** The second daemon fails fast because the ownership lock is already
held (and, on Windows, the first-instance named pipe cannot be recreated). The
original session's endpoint, credential, and I/O are unaffected. No second
endpoint is ever published (bind-before-publish holds — metadata is never
pointed at an unbound endpoint).

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## SIPC-8 — Remote uplink authenticates before bridging mux bytes

- **ID:** SIPC-8
- **Feature / phase:** Authenticated session IPC — remote uplink consumer.
- **Preconditions:** Two paired machines (or WSL↔Windows) with a working remote
  link/tunnel, per [phase09-remote.md](phase09-remote.md). A live session on the
  host that is advertised to the remote.
- **Config-matrix cell:** Consumer = remote uplink; transport = `local` on the
  host.
- **Platforms:** macOS/Linux/WSL host with a remote viewer; WSL↔Windows bridge.

**Steps:**
1. From the remote dashboard, open the advertised host session's terminal.
2. Type in the terminal and confirm bidirectional live I/O over the tunnel.
3. On the host, confirm the uplink connected to the daemon socket and that the
   session sidecar/credential never left the host (inspect uplink logs; the
   credential hex from SIPC-1 must not appear in any tunnel/mux payload or log).
4. Delete the host sidecar (as in SIPC-5) and retry opening the session from the
   remote.

**Expected:** The uplink completes the client handshake on the host's daemon
socket before forwarding any mux byte, so the remote viewer streams normally.
The per-session credential stays local to the host and never traverses the
tunnel. With the sidecar removed, the uplink fails closed (no unauthenticated
bridge) and the remote viewer cannot attach until the session is restarted.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## SIPC-9 — Windows named pipe is restricted to the current user (same-user DACL)

- **ID:** SIPC-9
- **Feature / phase:** Authenticated session IPC — Windows named-pipe transport.
- **Preconditions:** Windows host with the feature build. Ideally a second
  local user account for the cross-user check.
- **Config-matrix cell:** Transport = `local`; backend = Windows named pipe.
- **Platforms:** Windows.

**Steps:**
1. Start a session as user A: `climon cmd` (or `climon pwsh`).
2. Confirm `<id>.json` `socketPath` is `pipe://climon-<id>`.
3. Enumerate pipes and confirm it exists:
   `[System.IO.Directory]::GetFiles("\\.\pipe\") | Select-String climon`.
4. Inspect the pipe's security: use `accesschk.exe \pipe\climon-<id>` (Sysinternals)
   or a small script reading the pipe DACL.
5. As a **different** local user B (e.g. `runas /user:B pwsh`), attempt to open
   the pipe: `[System.IO.Pipes.NamedPipeClientStream]` against `climon-<id>`.
6. Confirm the pipe is not created a second time by another `climon __session <id>`
   (first-instance protection; see SIPC-7).

**Expected:** The named pipe's DACL grants access only to user A (plus
SYSTEM/Administrators). User B cannot open the pipe (access denied). Even if
user B could open it, the mutual handshake would still reject them for lacking
the owner-only credential. The pipe uses `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a
second daemon cannot hijack the name.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## SIPC-10 — Cross-version handshake is rejected cleanly (fail-closed, no crash)

- **ID:** SIPC-10
- **Feature / phase:** Authenticated session IPC — versioned handshake +
  pre-auth frame limits.
- **Preconditions:** A live session; a scratch client that can speak the
  handshake wire format (or a build with a bumped `IPC_PROTOCOL_VERSION` used
  only as a client).
- **Config-matrix cell:** Transport = `local` and `tcp`.
- **Platforms:** macOS, Linux, WSL, Windows.

**Steps:**
1. Connect and send an `AuthResponse` for an **unsupported** protocol version
   (or a malformed one) and observe the daemon's reply.
2. Connect and send a valid-looking frame whose declared payload length exceeds
   the pre-auth cap (4 KiB) and observe.
3. Send a valid handshake for a supported version (control) and confirm attach.
4. Throughout, confirm the daemon and the live session stay up (no crash, no
   wedged accept loop) and that many rapid pre-auth connections (>32) do not
   exhaust the daemon.

**Expected:** Unsupported/malformed handshakes are answered with an `AuthError`
(version-unsupported / malformed) and the connection closes; oversized pre-auth
frames are rejected. The daemon never crashes, the live session is unaffected,
and pre-auth connection concurrency is bounded (excess connections are dropped,
not queued unboundedly). A supported-version handshake still attaches normally.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |
