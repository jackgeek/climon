# Dev-tunnel launch probe timeout — no hang when `devtunnel` stalls

Manual checks that the launcher's Dev Tunnels detection probe cannot block a
`climon` session launch indefinitely. When remotes are enabled the launcher runs
`probe_devtunnel_sync` (`rust/climon-cli/src/launcher.rs`) before starting the
session host; the probe shells out to `devtunnel` via `climon-remote`
(`rust/climon-remote/src/devtunnel/gateway.rs` `run_command`). The probe is bounded
by `remote.devtunnelProbeTimeout` (default 5s), and `kill_on_drop(true)` guarantees
a stalled `devtunnel` child is terminated when the timeout fires so the launcher
proceeds to attach the session.

## DPT-01 — Launch does not hang when `devtunnel` stalls

- **ID:** DPT-01
- **Feature / phase:** Client (`climon-cli`) launcher dev-tunnel probe timeout —
  `probe_devtunnel_sync` + `devtunnel_probe_timeout` (`rust/climon-cli/src/launcher.rs`)
  and `kill_on_drop(true)` in `rust/climon-remote/src/devtunnel/gateway.rs` `run_command`.
- **Preconditions:** A Windows machine running the Rust `climon` client with
  `feature.remotes` enabled, `remote.enabled true`, and a `remote.tunnelId`
  configured. `devtunnel` is on `PATH` but made to stall on invocation (e.g. hold
  a `devtunnel` interactive/login prompt open in another window, or otherwise
  cause a `devtunnel` call to block without returning).
- **Config-matrix cell:** Remote / dev-tunnel, Windows host
- **Platforms:** Windows (primary — the orphaned-child hang is Windows-specific),
  macOS/Linux (smoke)

**Steps:**
1. Configure remotes as above and ensure a `devtunnel` invocation will stall.
2. Launch a session: `climon shell` (or `bun dev shell` on a dev build).
3. Observe the terminal. Within ~5 seconds (the default probe timeout) the session
   prompt appears and the terminal is interactive.
4. Confirm no orphaned `devtunnel` process from the probe remains (`Get-Process
   devtunnel*` on Windows) — the probe's child is killed on timeout.

**Expected:** The launch completes and attaches within ~5s despite the stalled
`devtunnel`; it does not hang waiting for `devtunnel` to return. The probe's
`devtunnel` child process is terminated (not left orphaned).

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## DPT-02 — `remote.devtunnelProbeTimeout` overrides the default

- **ID:** DPT-02
- **Feature / phase:** Client (`climon-cli`) — `remote.devtunnelProbeTimeout`
  config setting read by `devtunnel_probe_timeout` (`rust/climon-cli/src/launcher.rs`).
- **Preconditions:** Same as DPT-01 (remotes enabled, a stalling `devtunnel`).
- **Config-matrix cell:** Remote / dev-tunnel, Windows host
- **Platforms:** Windows (primary), macOS/Linux (smoke)

**Steps:**
1. Set a larger timeout: `climon config remote.devtunnelProbeTimeout 15` (global).
2. With `devtunnel` stalling, launch `climon shell` and note the elapsed time
   before the prompt appears — it should be ~15s, not ~5s.
3. Set an invalid value and confirm it is rejected:
   `climon config remote.devtunnelProbeTimeout 0` (and `-1`, `2.5`) must error;
   `climon config remote.devtunnelProbeTimeout 30` must succeed.
4. Reset to default: `climon config remote.devtunnelProbeTimeout 5`.

**Expected:** The launch waits approximately the configured number of seconds
before proceeding. Values below 1 and non-integers are rejected by the config
validator; valid integers ≥1 are accepted.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |
