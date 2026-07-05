# Uplink/ingest singleton — OS lock immune to PID recycling

Manual checks that the remote `uplink`/`ingest` singletons decide ownership from
an exclusive OS advisory lock on `<pidfile>.lock` (held for the process
lifetime) rather than a `is_process_alive(pid)` probe. This fixes the failure
where a dead uplink's PID is recycled onto an unrelated process (common on
Windows, e.g. `WUDFHost`), making a fresh uplink wrongly conclude another
instance is already running and exit silently — so local sessions never reach
the remote dashboard.

Relevant code: `rust/climon-remote/src/singleton.rs`
(`acquire_singleton_detailed` + `SingletonGuard`), held by
`rust/climon-remote/src/uplink.rs` (`run_uplink`) and
`rust/climon-remote/src/ingest.rs` (`run_ingest_daemon`).

## SLK-01 — Recycled uplink PID no longer blocks a fresh uplink

- **ID:** SLK-01
- **Feature / phase:** Remote (`climon-remote`) — singleton OS-lock ownership.
- **Preconditions:** A machine running the released Rust `climon` client with
  remote enabled (`remote.enabled true`), a `remote.tunnelId` whose tunnel is
  live and hosted, and `devtunnel` authenticated on `PATH`. No uplink currently
  running (`climon remotes` shows `uplink: stopped`).
- **Config-matrix cell:** Remote / dev-tunnel host
- **Platforms:** Windows (primary — PID recycling is most frequent here), macOS,
  Linux

**Steps:**
1. Write a stale pidfile that points at a **live, unrelated** process, simulating
   a recycled PID:
   - Windows (PowerShell): `Set-Content "$env:USERPROFILE\.climon\uplink.pid" $PID`
     (uses the current shell's PID, which is alive but is not a climon uplink).
   - macOS/Linux: `echo $$ > ~/.climon/uplink.pid`
2. Ensure no live uplink holds the lock: confirm no `climon` uplink process is
   running and remove any leftover `~/.climon/uplink.pid.lock` **only if** no
   uplink process is alive.
3. Start the uplink: run `climon __uplink` (or launch any `climon` session,
   which auto-spawns the uplink).
4. Run `climon remotes` (or `climon remotes --watch`).

**Expected:** The uplink acquires the singleton despite the recycled PID in the
pidfile, connects to the tunnel, and `climon remotes` shows
`uplink: running (pid …)` with a `connected` line and a session count. Before
this fix the uplink exited immediately and `remotes` stayed at
`uplink: stopped`.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## SLK-02 — Only one uplink runs while another holds the lock

- **ID:** SLK-02
- **Feature / phase:** Remote (`climon-remote`) — singleton mutual exclusion.
- **Preconditions:** Same as SLK-01, with one uplink already `connected`.
- **Config-matrix cell:** Remote / dev-tunnel host
- **Platforms:** Windows, macOS, Linux

**Steps:**
1. With one uplink already running and `connected`, start a second uplink
   (`climon __uplink`) in another terminal.
2. Observe that the second process exits immediately.
3. Kill the first uplink process, then start a new uplink.

**Expected:** The second uplink exits without disturbing the first (no duplicate
connection, no error spew). After the first is killed, a new uplink acquires the
lock and connects — the released OS lock never leaves a fresh instance blocked.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |
