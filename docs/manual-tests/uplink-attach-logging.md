# Uplink writes a diagnostic log and records the attach lifecycle

Manual checks that the detached devbox uplink now writes an NDJSON log under
`$CLIMON_HOME/logs/uplink/` and records the connect/reconcile/attach lifecycle,
so a "session is listed on the dashboard but its terminal stays blank" report can
be diagnosed from logs instead of guesswork.

Background: the detached `climon __uplink` process routes stdout/stderr to null
and previously installed **no** file logger (the `LogRole::Uplink` role was
defined but never used), and `attach()` swallowed every connect/auth error
(`Err(_) => return`). Together that made the remote attach path a black box. The
uplink now installs the `Uplink` role logger (`run_uplink_entry`,
`rust/climon-cli/src/run.rs`) and logs supervisor start, ingest connect/close,
reconcile counts, and — critically — attach success, the exact attach failure
error, and the reader outcome (bytes forwarded + why it ended)
(`rust/climon-remote/src/uplink.rs` `attach`/`reconcile`/`run_target_bridge`).

## UAL-01 — Uplink log records a successful dashboard attach

- **ID:** UAL-01
- **Feature / phase:** Remote (`climon-remote`) — uplink attach diagnostics.
- **Preconditions:** A devbox running this build with remote enabled
  (`remote.enabled true`) and a live/hosted tunnel; the uplink connects
  (`climon remotes` shows `uplink: running` / `connected`). A remote machine has
  the dashboard open and can see this devbox's sessions.
- **Config-matrix cell:** Remote / dev-tunnel host
- **Platforms:** Windows (primary), macOS, Linux

**Steps:**
1. Start a session on the devbox and confirm it appears on the remote dashboard.
2. On the remote dashboard, click the session to open its terminal.
3. On the devbox, read the newest `$CLIMON_HOME/logs/uplink/*.log`.

**Expected:** The log contains an `uplink supervisor started` line, an
`uplink connected to ingest channel` line, and — when the terminal is opened —
an `uplink attached: streaming session output to dashboard` line for that
`sessionId`, followed (on close) by an `uplink attach reader ended` line whose
`bytesForwarded` is greater than 0 when output flowed.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## UAL-02 — A failed authenticated attach is logged loudly

- **ID:** UAL-02
- **Feature / phase:** Remote (`climon-remote`) — uplink attach failure diagnostics.
- **Preconditions:** Same as UAL-01, but reproduce (or simulate) a state where the
  uplink cannot open the authenticated session socket — e.g. a session started by
  an older, unauthenticated climon (no IPC credential sidecar), so
  `open_authenticated_session` fails closed.
- **Config-matrix cell:** Remote / dev-tunnel host
- **Platforms:** Windows (primary), macOS, Linux

**Steps:**
1. With the uplink connected, click the affected session's terminal on the remote
   dashboard (the tile is listed, but the terminal shows nothing).
2. On the devbox, read the newest `$CLIMON_HOME/logs/uplink/*.log`.

**Expected:** The log contains an `error`-level
`uplink attach failed: could not open authenticated session socket` line naming
the `sessionId`, `socketPath`, `errorKind`, and the exact `error` string — turning
the previously silent blank-terminal symptom into an actionable diagnosis.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |
