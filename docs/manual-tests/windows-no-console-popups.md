# Windows — no console-window popups from remote child processes

Manual checks that the Rust client's remote subprocesses (`devtunnel`, and the
`tasklist`/`taskkill` liveness/kill helpers, and peer-discovery tools) run with
the Windows `CREATE_NO_WINDOW` flag so they never flash a console window.

## WNW-01 — Uplink reconnect loop never flashes `devtunnel.exe` windows

- **ID:** WNW-01
- **Feature / phase:** Remote (`climon-remote`) — `CREATE_NO_WINDOW` on the
  uplink's `devtunnel` spawns (`rust/climon-remote/src/uplink.rs`
  `devtunnel_command`, used by `spawn_connect` + `discover_tunnel_port`).
- **Preconditions:** A Windows machine running the released Rust `climon` client
  with remote enabled and a `remote.tunnelId` configured whose tunnel is **not
  currently hosted** (so the uplink stays in its reconnect/backoff loop and
  re-spawns `devtunnel` every ~15–60s). `devtunnel` is on `PATH`.
- **Config-matrix cell:** Remote / dev-tunnel, Windows host
- **Platforms:** Windows (primary)

**Steps:**
1. Ensure the tunnel target is unreachable (stop the host side / pick a tunnel id
   that is not being hosted).
2. Start the uplink (launch any `climon` session, or `climon __uplink`) and leave
   it running for at least 3–4 minutes.
3. Watch the desktop, taskbar, and Windows Terminal while it retries (confirm via
   `~/.climon/logs/uplink/*.log` that `uplink.devtunnel_connect_spawning` /
   reconnect entries are being written).

**Expected:** No `devtunnel.exe` console windows appear or flash on the taskbar
at any point during the retry loop. The uplink log still shows the reconnect
attempts (the processes run, just hidden).

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## WNW-02 — Peer discovery / liveness helpers don't flash windows

- **ID:** WNW-02
- **Feature / phase:** Remote (`climon-remote`) — `CREATE_NO_WINDOW` on
  `process.rs` (`tasklist`/`taskkill`) and `peer.rs` (`default_run` peer-discovery
  shell-outs).
- **Preconditions:** Windows machine running the Rust `climon` client with remote
  enabled. A WSL distro with its own climon home is reachable (so peer discovery
  shells out to `wsl.exe`/`wslpath`), and at least one prior `server.json` exists
  so the liveness `tasklist` probe runs.
- **Config-matrix cell:** Remote / WSL↔Windows, Windows host
- **Platforms:** Windows (primary)

**Steps:**
1. Start the uplink/launcher so peer discovery and the `server.json` liveness
   probe run on each cycle.
2. Observe the taskbar/desktop for ~2 minutes while discovery iterates.

**Expected:** No `tasklist`, `taskkill`, `cmd.exe`, or `wsl.exe` console windows
flash during discovery or liveness checks.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |
