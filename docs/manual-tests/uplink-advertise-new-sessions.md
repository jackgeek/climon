# Uplink advertises sessions created after it connects

Manual checks that the devbox uplink re-advertises local sessions to the remote
dashboard whenever the sessions directory changes — not only at connect time.
The uplink runs `reconcile` once when the mux channel connects and then watches
`$CLIMON_HOME/sessions` (polling, the workspace's `fs.watch` equivalent),
re-running `reconcile` when the set of `*.json` metadata files or their
size/mtime changes. This fixes the regression where a session started **after**
the uplink connected never appeared on the remote dashboard until the tunnel
dropped and reconnected.

Relevant code: `rust/climon-remote/src/uplink.rs` (`run_uplink_bridge`
sessions-dir watcher via `shutdown_watch::spawn_poll` + `sessions_signature`,
feeding the `reconcile_signal` arm in the main `select!` loop). Restores the
behaviour of the removed TS `watch(getSessionsDir(env), () => reconcile(bridge))`.

## UAN-01 — Session started after the uplink connects appears remotely

- **ID:** UAN-01
- **Feature / phase:** Remote (`climon-remote`) — uplink live session re-advertise.
- **Preconditions:** A devbox running the released Rust `climon` client with
  remote enabled (`remote.enabled true`), a live/hosted tunnel, and `devtunnel`
  authenticated on `PATH`. The uplink is already `connected` (`climon remotes`
  shows `uplink: running (pid …)` with a `connected` line). At least one session
  already exists so the initial reconcile has advertised something. A remote
  machine has the dashboard open and can see this devbox's sessions.
- **Config-matrix cell:** Remote / dev-tunnel host
- **Platforms:** Windows (primary), macOS, Linux

**Steps:**
1. On the remote dashboard, confirm the devbox's existing sessions are listed.
2. On the devbox, **without restarting the uplink**, start a brand-new session,
   e.g. `climon run --name devbox-late-1 -- bash` (or launch any `climon`
   session).
3. Wait a couple of seconds (the watcher polls ~once per second).
4. Refresh / observe the remote dashboard's session list for this devbox.

**Expected:** The newly created session (`devbox-late-1`) appears on the remote
dashboard within a few seconds, with no uplink restart and no tunnel reconnect.
Before this fix the session never appeared until the uplink was restarted or the
tunnel dropped.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## UAN-02 — Ending a session is reflected remotely

- **ID:** UAN-02
- **Feature / phase:** Remote (`climon-remote`) — uplink session removal re-advertise.
- **Preconditions:** Same as UAN-01, with the session from UAN-01 (or any local
  session) visible on the remote dashboard.
- **Config-matrix cell:** Remote / dev-tunnel host
- **Platforms:** Windows, macOS, Linux

**Steps:**
1. On the remote dashboard, confirm a local session is listed.
2. On the devbox, end that session (exit the shell, or `climon kill <id>`), so its
   metadata file is removed or marked terminal.
3. Wait a couple of seconds, then observe the remote dashboard.

**Expected:** The session's live state updates remotely (removed or transitioned
to a terminal status) without an uplink restart, because the sessions-dir change
triggers a fresh reconcile that emits the corresponding `session-removed` /
updated snapshot.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |
