# Ingest hosts the remotes dev tunnel (`devtunnel host`)

Manual checks that the Rust `climon __ingest` daemon actually spawns
`devtunnel host <tunnelId>` for the configured remotes tunnel, so a remote
devbox can connect over the dev tunnel and appear in the dashboard "Remote
hosts" flyout. Regression cover for the bug where the production ingest wired a
no-op `spawn_host` and the tunnel was never bound to the relay
(`rust/climon-cli/src/main.rs` `run_ingest_entry` →
`climon_remote::ingest::spawn_devtunnel_host`).

## ITH-01 — Creating a remotes tunnel hosts it automatically

- **ID:** ITH-01
- **Feature / phase:** Remote (`climon-remote`) — ingest `TunnelHostSupervisor`
  wired to the real `spawn_devtunnel_host` (`rust/climon-remote/src/ingest.rs`).
- **Preconditions:** A home machine running the released Rust `climon` client +
  `climon-server` dashboard with `feature.remotes` enabled. `devtunnel` is on
  `PATH` and logged in (`devtunnel user show`).
- **Config-matrix cell:** Remote / dev-tunnel, home host (macOS/Linux/Windows)
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Start or restart `climon server`, then open the dashboard → **Remotes**
   dialog. Note the auto-managed tunnel id (for example,
   `climon-ingest-….eun1`).
2. Within ~5 seconds (the supervisor's reconcile interval), check that the
   ingest spawned a host process: `ps`/Task Manager shows a
   `devtunnel host <tunnelId>` process owned by the ingest.
3. Run `devtunnel show <tunnelId>` and confirm **Host connections: 1**.

**Expected:** A `devtunnel host <tunnelId>` child is running and the tunnel
reports one host connection. The dashboard no longer requires a manual
`devtunnel host`.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## ITH-02 — Remote devbox connects and appears in the flyout

- **ID:** ITH-02
- **Feature / phase:** Remote (`climon-remote`) — end-to-end dev-tunnel uplink →
  ingest now that the home ingest hosts the tunnel.
- **Preconditions:** ITH-01 passed (home ingest is hosting the tunnel). A second
  machine (the devbox) with the Rust `climon` client and `devtunnel` logged in to
  the **same account**.
- **Config-matrix cell:** Remote / dev-tunnel, cross-machine
- **Platforms:** macOS, Linux, Windows (devbox)

**Steps:**
1. On the devbox, run the setup script from the Remotes dialog (sets
   `remote.enabled true` and `remote.tunnelId <new id>`).
2. Start a `climon` session on the devbox.
3. On home, run `climon remotes` and open the home dashboard.

**Expected:** The devbox appears in `climon remotes` as a live host
(`● <hostname> (<os>) — <addr> — N sessions`). The devbox's session is visible
in the dashboard session list.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## ITH-03 — Restarting the server keeps hosting the same tunnel

- **ID:** ITH-03
- **Feature / phase:** Remote (`climon-remote`) — supervisor continues to host
  the server-managed `remote-host.json` tunnel state.
- **Preconditions:** ITH-01 passed (a `devtunnel host` is running).
- **Config-matrix cell:** Remote / dev-tunnel, home host
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Stop and restart `climon server`.
2. Within ~5s confirm a `devtunnel host <same tunnel id>` process is running.
3. Run `devtunnel show <tunnelId>` and confirm **Host connections: 1**.

**Expected:** The host process tracks `remote-host.json` after restart and
continues hosting the same auto-managed tunnel. No orphaned `devtunnel host`
processes are left behind.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## ITH-04 — Color dropdown defaults to empty and omits `session.color`

- **ID:** ITH-04
- **Feature / phase:** Remote (`climon-remote`) — Remotes dialog setup-script
  generation (`buildSetupScript`, `RemoteClientDialog`).
- **Preconditions:** ITH-01 passed (a tunnel id exists, so the setup script is
  generated).
- **Config-matrix cell:** Remote / dev-tunnel, home host
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Open the Remotes dialog on the home dashboard.
2. Observe the **Color** dropdown's initial value.
3. Read the generated setup script without changing the dropdown.
4. Select a concrete color (e.g. `green`) and re-read the script.
5. Re-select **Default** and re-read the script.

**Expected:** The Color dropdown defaults to **Default** (empty). While
**Default** is selected the setup script contains **no** `climon config
session.color` line. Selecting `green` adds `climon config session.color green`;
re-selecting **Default** removes the line again.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |
