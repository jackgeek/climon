# Phase 9 — `climon-remote` (uplink / ingest / WSL↔Windows link)

These cases prove that the ported `climon-remote` crate and the now-wired
`climon` remote commands behave like the TypeScript remote stack and stay
**byte-for-byte interop** with the unchanged Bun dashboard server and Bun remote
peers. The #1 invariant is the **mux wire format and the uplink/ingest mux
protocol**: a Rust uplink must talk to a Bun ingest (and a Bun uplink to a Rust
ingest) with identical bytes.

Background: Phase 9 ports `src/remote/*.ts` — `mux.ts`, `client-id.ts`,
`ingest-port.ts`, `ingest-bind-host.ts`, `ingest-state.ts`, `ingest.ts`,
`uplink.ts`, `uplink-spawn.ts`, `tunnel.ts`, `discovery.ts`, `peer.ts`,
`link.ts`, `keepalive.ts`, `singleton.ts`, `demotion.ts`, `shutdown-request.ts`,
`shutdown-watch.ts`, and `teardown.ts` — into `rust/climon-remote`, and wires the
deferred Phase-8 stubs: `climon __uplink`, `climon __ingest`, `climon link`,
`climon cleanup`, plus the launcher's `ensureUplink` / `maybeAutoLink`. The
remote mux/uplink/ingest run on a tokio runtime that the thread-based CLI bridges
to. See the
[master plan](../superpowers/plans/2026-06-17-rust-client-rewrite-master-plan.md)
and the [Phase 9 plan](../superpowers/plans/2026-06-18-phase09-climon-remote.md).

All cases treat remote input as **untrusted** (bounded mux frames, remote-ID
validation, metadata namespacing, patch allowlists, loopback-only privileged
APIs) per [docs/security.md](../security.md). Cases isolate state with a temp
`CLIMON_HOME` so they never touch a real `~/.climon`.

This phase spans the **transport** and **OS** dimensions:

| Cell | OS | Transport | Notes |
|---|---|---|---|
| RMT-direct | any | Direct loopback/LAN TCP (`remote.host` + `remote.port`) | No devtunnel required. |
| RMT-tunnel | any | Microsoft dev tunnel (`remote.tunnelId`) | Requires the `devtunnel` CLI logged in. |
| RMT-peer | WSL ⇄ Windows (same machine) | Peer discovery via `remote.peerHome` | `server.json`/`ingest.json` beacons + TCP probe. |

---

## MT-P9-01 — `climon-remote` builds, tests, and lints; mux bytes pin

- **ID:** MT-P9-01
- **Feature / phase:** Phase 9 — `climon-remote` crate
- **Preconditions:** Repo checked out; stable Rust toolchain with `rustfmt` +
  `clippy`; `cargo-deny` + `cargo-about` installed; Bun installed.
- **Config-matrix cell:** all
- **Platforms:** macOS (arm64), Linux (x64), Windows (x64)

**Steps:**
1. From the repo root: `cd rust`.
2. Build/test: `cargo test --workspace`.
3. Lint gates: `cargo fmt --all --check` and
   `cargo clippy --workspace --all-targets -- -D warnings`.
4. License gate: `cargo deny check`; confirm `THIRD-PARTY-LICENSES.md` is
   idempotent (`cargo about generate about.hbs`).
5. Cross-language mux byte pin (from repo root):
   `bun test tests/remote-fixtures.test.ts`.

**Expected:** All steps pass; the Bun fixture test confirms the Rust encoder
produces byte-identical control/data frames to the Bun `encodeControl`/
`encodeData`, and both decoders round-trip each other's frames.

---

## MT-P9-02 — Uplink a local session to a remote dashboard (RMT-direct)

- **ID:** MT-P9-02
- **Feature / phase:** Phase 9 — uplink client
- **Preconditions:** Two machines (or two `CLIMON_HOME`s); a Bun dashboard
  server running on the "host"; `remote.enabled true`, `remote.host <host-ip>`,
  `remote.port <ingest-port>` on the "devbox".
- **Config-matrix cell:** RMT-direct
- **Platforms:** Linux/macOS/Windows

**Steps:**
1. On the host, start the dashboard (`climon server`) and note the ingest port.
2. On the devbox, set `remote.enabled`/`remote.host`/`remote.port`.
3. On the devbox, start a session: `climon run -- bash`.
4. Observe that a detached `climon __uplink` is spawned (it self-targets the
   host) and the session appears on the host dashboard.
5. Type in the devbox session; confirm output streams to the dashboard viewer.

**Expected:** The session is advertised to the host (`hello` → `session-added`),
data bridges both ways, and detaching the last browser viewer hands PTY control
back to the remaining surface by priority. Killing the devbox session removes it
from the dashboard.

---

## MT-P9-03 — Ingest receives a remote session and namespaces it (untrusted)

- **ID:** MT-P9-03
- **Feature / phase:** Phase 9 — ingest server
- **Preconditions:** A running ingest daemon (`climon __ingest`, or the Bun
  server's ingest) and a connecting uplink (Rust or Bun).
- **Config-matrix cell:** RMT-direct
- **Platforms:** Linux/macOS/Windows

**Steps:**
1. Start the ingest daemon on the host; confirm `ingest.json` + `ingest.pid`
   beacons appear and a listener binds.
2. Connect an uplink advertising a session id like `s1`.
3. Inspect the host `CLIMON_HOME/sessions`: the remote session is materialized
   with a **namespaced** id (`<clientId>~s1`), `origin: "remote"`, and a local
   loopback socket ref.
4. From a malicious uplink, send (a) an oversize mux frame (>8 MiB), (b) an
   invalid remote id, (c) a `session-updated` patch with server-owned fields.

**Expected:** Normal sessions appear namespaced and origin-tagged. The oversize
frame tears the connection down; invalid remote ids are rejected; the patch is
filtered to the allowlist (server-owned fields ignored). Disconnecting the
uplink removes its remote sessions.

---

## MT-P9-04 — Dev tunnel detection & connect (RMT-tunnel)

- **ID:** MT-P9-04
- **Feature / phase:** Phase 9 — tunnel + uplink tunnel mode
- **Preconditions:** `devtunnel` CLI installed and logged in; `remote.enabled
  true`, `remote.tunnelId <id>` on the devbox; a tunnel hosted on the dashboard
  side.
- **Config-matrix cell:** RMT-tunnel
- **Platforms:** Linux/macOS/Windows

**Steps:**
1. With `devtunnel` **absent**, start a session — confirm the launcher prints
   the "devtunnel CLI is not installed" warning and does **not** spawn an uplink.
2. Install/login `devtunnel`; restart a session — confirm `climon __uplink`
   spawns, discovers the forwarded port (`devtunnel port list`), runs
   `devtunnel connect`, waits for the port, and bridges.
3. Force an auth-rejection (use a tunnel you're not authorized for) — confirm
   the uplink prints "dev tunnel auth rejected … Stopping." and exits non-zero.

**Expected:** `planUplinkStart` gates spawning on devtunnel availability;
tunnel-mode uplink discovers + connects; clear auth rejection stops retrying.

---

## MT-P9-05 — WSL ⇄ Windows link & discovery (RMT-peer)

- **ID:** MT-P9-05
- **Feature / phase:** Phase 9 — link + discovery + peer
- **Preconditions:** A Windows host with a WSL distro; climon installed on both.
- **Config-matrix cell:** RMT-peer
- **Platforms:** Windows + WSL

**Steps:**
1. In non-interactive automation, run `climon link --no-wsl-bridge`. Confirm it
   writes `remote.peerHome` but does not prompt and does not write
   `feature.wslBridge`.
2. From WSL in a TTY, run `climon link` (or `climon link --wsl-bridge`) and
   accept the prompt. Confirm it auto-detects the Windows `CLIMON_HOME`, writes
   the local `remote.peerHome` pointer, writes the reverse pointer into the
   Windows config, and writes `feature.wslBridge enabled` on both sides.
3. Start the Windows dashboard (`climon server`).
4. From WSL, start a session (`climon run -- bash`). Confirm the launcher
   discovers the peer dashboard (`server.json` beacon + ingest TCP probe),
   prints "dashboard detected on the peer OS …", and bridges via the uplink to
   the Windows ingest port.
5. Clear `remote.peerHome`, leave `feature.wslBridge` unset, then start a fresh
   WSL session so auto-link runs. Confirm auto-link configures discovery and
   explicitly says the WSL bridge is NOT enabled.
6. Toggle `remote.autoLink false` and confirm auto-link stays silent on a fresh
   WSL session.

**Expected:** `linkPeer` configures both directions and only enables the WSL
bridge after an explicit prompt/`--wsl-bridge`; `discoverDashboard` returns a
`peer` target validated by the ingest beacon + TCP probe; `maybeAutoLink`
announces/advises/links unless disabled or already linked and never enables the
bridge automatically.

---

## MT-P9-06 — Keepalive, singleton recycle, demotion, cleanup

- **ID:** MT-P9-06
- **Feature / phase:** Phase 9 — keepalive / singleton / demotion / teardown
- **Preconditions:** A host running a dashboard + ingest; a devbox uplink.
- **Config-matrix cell:** RMT-direct or RMT-peer
- **Platforms:** Linux/macOS/Windows

**Steps:**
1. **Keepalive:** set `remote.keepAlive` to a small value; confirm periodic
   `ping` frames flow and an unanswered idle channel is torn down + reconnected.
2. **Singleton:** start two `climon __uplink` (or `__ingest`) processes; confirm
   the second fails to take the OS lock on `<pidfile>.lock`, declines, and exits
   0. Kill the holder and start again; confirm the released lock lets a fresh
   instance acquire even if the old pidfile's PID has been recycled (see
   [singleton-lock-pid-recycle.md](singleton-lock-pid-recycle.md)).
3. **Demotion:** with a co-located dashboard + ingest, write a shutdown-request
   beacon (allowlisted requester); confirm the ingest demotes — drops its
   listener, spawns a detached `__uplink`, stops the local server, and removes
   its beacons (the port is freed).
4. **Cleanup:** run `climon cleanup`; confirm it stops the dashboard server,
   ingest, and uplink, removes their beacons only after each process is
   confirmed dead, and reports failures with manual remediation advice (exit 1
   when a kill fails). Run it again on a clean machine → "Nothing to clean up".

**Expected:** Keepalive prevents idle tunnel drops; the singleton is honored and
recycles stale pids; demotion frees the ingest port and hands off to an uplink;
`cleanup` is idempotent and verifies death before removing beacons.
