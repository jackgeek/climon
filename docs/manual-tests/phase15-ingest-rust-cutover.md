# Phase 15 — Ingest Rust cutover

Manual checks for moving the production **ingest** to the Rust client binary and
bringing it to control-plane parity with the legacy Bun ingest: the remote-spawn
control socket, dual-listen loopback, sessions-dir dismiss watcher, authoritative
`session-list` ghost GC, gate #3 (same-machine peer refused when `wslBridge` is
off), and the security hardening (control-socket auth, bounded control lines,
namespace-scoped snapshot deletion).

| Cell | Scenario | Notes |
|---|---|---|
| ING-SPAWN | Remote spawn end-to-end | Control socket + signing + spawn-result. |
| ING-TUNNEL | Dual-listen reachability | Non-loopback bind + `devtunnel host`. |
| ING-DEL-LIVE | Delete while connected | `session-removed` → meta deleted. |
| ING-DEL-GC | Delete while disconnected | `session-list` snapshot GC on reconnect. |
| ING-PRESERVE | Disconnected preserved | Dead-daemon session kept on home. |
| ING-DEV-ERR | Dev requires Rust binary | No Bun ingest fallback. |
| ING-GATE3 | Peer refused, bridge off | Gate #3 transport guard. |
| ING-SEC-AUTH | Control-socket auth (A1) | `controlToken` from `ingest.json`. |
| ING-SEC-SPOOF | Snapshot deletion scope (A3) | Signed/namespace-scoped deletes. |
| ING-SEC-LINE | Oversized control line (A2) | 64 KiB cap tears down. |

---

## MT-P15-01 — Remote spawn end-to-end via the Rust ingest

- **ID:** MT-P15-01
- **Feature / phase:** Ingest Rust cutover — remote-spawn control socket
- **Preconditions:** Home machine and a devbox, both with a freshly built Rust
  `climon`; `feature.remotes` enabled on home; a connected dev tunnel between
  them; `remote.spawnSecret` set identically on both sides.
- **Config-matrix cell:** ING-SPAWN
- **Platforms:** Linux/macOS/Windows (home) + Linux (devbox)

**Steps:**
1. Start `climon server` on home and confirm `ingest.json` publishes a
   `controlSocket` field.
2. Confirm the devbox uplink is connected (a session from the devbox appears on
   the home dashboard).
3. From the home dashboard (or `climon remotes spawn`), request a new session on
   the connected devbox.
4. Watch the home dashboard and the devbox.

**Expected result:** The spawn request is signed, forwarded over the mux to the
devbox uplink, and a new session is created on the devbox and materialized on
home; the control socket returns a `spawn-result` with the new session id and no
error.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P15-02 — Dual-listen loopback accepts forwarded connections

- **ID:** MT-P15-02
- **Feature / phase:** Ingest Rust cutover — dual-listen loopback
- **Preconditions:** Home machine with `feature.remotes` enabled and the ingest
  bound to a non-loopback host (auto-detected interface or `remote.ingestHost`
  set to a routable address); `devtunnel` available.
- **Config-matrix cell:** ING-TUNNEL
- **Platforms:** Linux/macOS/Windows

**Steps:**
1. Start `climon server` so the ingest binds the non-loopback host.
2. Confirm `ingest.json` shows the non-loopback `host` and a `port`.
3. Let `devtunnel host` forward the tunnel to `127.0.0.1:<port>` and connect a
   devbox uplink through it.
4. Observe the devbox sessions on the home dashboard.

**Expected result:** The ingest also listens on `127.0.0.1:<port>`, so the
`devtunnel`-forwarded loopback connection is accepted and the devbox sessions
stream on home; no `EADDRINUSE`/connection-refused on the loopback path.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P15-03 — Delete while connected removes the session

- **ID:** MT-P15-03
- **Feature / phase:** Ingest Rust cutover — `session-removed` deletes meta
- **Preconditions:** A connected devbox with at least one live session showing on
  the home dashboard.
- **Config-matrix cell:** ING-DEL-LIVE
- **Platforms:** Linux/macOS/Windows (home) + Linux (devbox)

**Steps:**
1. Confirm a devbox session is visible on the home dashboard.
2. On the devbox, end/kill that session so the source emits `session-removed`.
3. Watch the home dashboard and the home `~/.climon/sessions/` directory.

**Expected result:** The session disappears from the home dashboard immediately
and its `<clientId>~<id>.json` meta file is deleted (not merely flipped to
disconnected).

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P15-04 — Delete while disconnected GCs on reconnect

- **ID:** MT-P15-04
- **Feature / phase:** Ingest Rust cutover — authoritative `session-list` GC
- **Preconditions:** A connected devbox with at least two live sessions on home.
- **Config-matrix cell:** ING-DEL-GC
- **Platforms:** Linux/macOS/Windows (home) + Linux (devbox)

**Steps:**
1. Confirm two devbox sessions are visible on home.
2. Stop the devbox uplink (so no `session-removed` is delivered live).
3. On the devbox, delete one of the two sessions.
4. Restart the devbox uplink and let it reconcile.

**Expected result:** On reconnect the uplink emits a `session-list` snapshot of
only the surviving session; the home ingest garbage-collects the deleted one
(including any ghost meta left from the previous connection) and it does **not**
reappear on the home dashboard.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P15-05 — Disconnected-but-present session is preserved

- **ID:** MT-P15-05
- **Feature / phase:** Ingest Rust cutover — snapshot preserve
- **Preconditions:** A connected devbox with a live session on home.
- **Config-matrix cell:** ING-PRESERVE
- **Platforms:** Linux/macOS/Windows (home) + Linux (devbox)

**Steps:**
1. Confirm the devbox session is visible on home.
2. On the devbox, kill the session's daemon process but leave its metadata file
   in place (so the session still appears in the source's `session-list`).
3. Let the uplink reconcile and emit its snapshot.

**Expected result:** The session remains listed on the home dashboard as
disconnected; because it is still in the authoritative snapshot it is not
GC'd.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P15-06 — Dev run requires the built Rust ingest (no Bun fallback)

- **ID:** MT-P15-06
- **Feature / phase:** Ingest Rust cutover — dev binary requirement
- **Preconditions:** A dev source checkout; `feature.remotes` enabled; the Rust
  `climon` binary **not** built (or removed from the resolution path).
- **Config-matrix cell:** ING-DEV-ERR
- **Platforms:** Linux/macOS/Windows

**Steps:**
1. Ensure no built Rust `climon` is resolvable for the dev checkout.
2. Run `bun src/server.ts server` with `feature.remotes` enabled.
3. Observe the startup output when ingest is requested.

**Expected result:** The server reports a clear "Rust client binary is not
built" style error and does **not** fall back to spawning the Bun `__ingest`;
building the Rust client and retrying resolves it.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P15-07 — Gate #3 refuses a same-machine peer when the bridge is off

- **ID:** MT-P15-07
- **Feature / phase:** Ingest Rust cutover — gate #3 transport guard
- **Preconditions:** Windows host with WSL; `feature.remotes` enabled on the
  ingest side; `feature.wslBridge` **disabled** on both sides; a way to force a
  same-machine peer uplink (`hello.peer = true`).
- **Config-matrix cell:** ING-GATE3
- **Platforms:** Windows + WSL

**Steps:**
1. Enable `feature.remotes` and disable `feature.wslBridge` on the ingest host.
2. Force a same-machine peer uplink toward the ingest (peer hello).
3. Observe the connection and the home dashboard.
4. Enable `feature.wslBridge` and retry.

**Expected result:** With the bridge off, the ingest tears down the peer hello
connection and no peer sessions are materialized. With `feature.wslBridge`
enabled, the same peer connection is accepted and its sessions appear. (A
non-peer tunnel uplink is always accepted regardless of `wslBridge`.)

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P15-08 — Control-socket auth rejects requests without the token (A1)

- **ID:** MT-P15-08
- **Feature / phase:** Ingest Rust cutover — control-socket auth
- **Preconditions:** Home machine with `feature.remotes` enabled; the ingest
  running with a published `controlSocket` and a per-run `controlToken` in the
  `0600` `ingest.json`.
- **Config-matrix cell:** ING-SEC-AUTH
- **Platforms:** Linux/macOS/Windows

**Steps:**
1. Read `ingest.json` and note the `controlSocket` and `controlToken`.
2. Send a `SpawnControlRequest` line to the control socket **without** a
   `controlToken` (and again with a wrong token).
3. Send the same request via the dashboard server path (which reads the token
   from `ingest.json`).

**Expected result:** The token-less and wrong-token requests are rejected with no
spawn; the dashboard server, supplying the correct token, spawns successfully.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P15-09 — Snapshot deletion stays scoped / signed (A3)

- **ID:** MT-P15-09
- **Feature / phase:** Ingest Rust cutover — session-list deletion scope
- **Preconditions:** Home ingest with one devbox (`clientId = devA`) connected
  and at least one local session plus one `devB~` remote session also present.
- **Config-matrix cell:** ING-SEC-SPOOF
- **Platforms:** Linux/macOS/Windows

**Steps:**
1. With `remote.spawnSecret` set, open a second connection claiming `clientId
   = devA` and send an **unsigned** `session-list: []` snapshot.
2. Observe whether any sessions are deleted.
3. Repeat with `remote.spawnSecret` unset (no secret).
4. Inspect local sessions and the unrelated `devB~` sessions.

**Expected result:** With a secret set, the unsigned snapshot is rejected and no
sessions are deleted. With no secret, deletion is confined to the `devA~`
namespace and `Origin::Remote` files only — local sessions and other-namespace
(`devB~`) sessions are untouched, and no path-traversal escapes the namespace
prefix.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P15-10 — Oversized control line tears down the connection (A2)

- **ID:** MT-P15-10
- **Feature / phase:** Ingest Rust cutover — bounded control lines
- **Preconditions:** Home ingest running with a published `controlSocket`.
- **Config-matrix cell:** ING-SEC-LINE
- **Platforms:** Linux/macOS/Windows

**Steps:**
1. Connect to the loopback control socket.
2. Send a control line exceeding 64 KiB without a newline.
3. Monitor the ingest's memory and the connection.

**Expected result:** The connection is torn down once the line exceeds the cap;
the ingest does not buffer unbounded memory and keeps serving other connections.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_
