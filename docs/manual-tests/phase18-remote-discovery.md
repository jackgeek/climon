# Remote devbox auto-discovery + multi-target fan-out

Manual checks for devbox-side discovery of live `climon-ingest` dev tunnels and
concurrent fan-out to multiple dashboard hosts.

## RDD-01 — Devbox discovers a host without `remote.tunnelId`

- **ID:** RDD-01
- **Feature / phase:** Remote discovery — devbox `climon __uplink` scans
  `devtunnel list --labels climon-ingest --json`.
- **Preconditions:** Host A has `feature.remotes enabled`, `devtunnel` installed
  and logged in, and a running `climon server` hosting a `climon-ingest` tunnel.
  The devbox has the Rust `climon` client and is logged into the same dev tunnel
  account.
- **Config-matrix cell:** Remote / dev-tunnel, same account, discovery enabled
- **Platforms:** macOS, Linux, Windows (host and devbox)

**Steps:**
1. On the devbox, ensure no explicit tunnel is configured:
   `climon config --unset remote.tunnelId` (ignore "unset" errors if absent).
2. Run `climon config remote.enabled true`.
3. Start a devbox session: `climon echo remote-discovery`.
4. Open Host A's dashboard and `climon remotes`.

**Expected:** The devbox session appears on Host A without setting
`remote.tunnelId`. `climon remotes` shows the uplink targeting Host A's tunnel.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## RDD-02 — One devbox fans out to two live hosts

- **ID:** RDD-02
- **Feature / phase:** Remote discovery — multi-target uplink supervisor.
- **Preconditions:** RDD-01 passed. Host B is a second dashboard host logged into
  the same dev tunnel account with `feature.remotes enabled` and `climon server`
  running.
- **Config-matrix cell:** Remote / dev-tunnel, two live hosts, discovery enabled
- **Platforms:** macOS, Linux, Windows (hosts and devbox)

**Steps:**
1. Confirm both hosts are live: `devtunnel list --labels climon-ingest --json`
   shows two tunnels with `hostConnections >= 1`.
2. Start another devbox session: `climon echo fanout`.
3. Open both dashboards and run `climon remotes` on the devbox.

**Expected:** The same devbox sessions appear on both Host A and Host B. The
devbox maintains concurrent uplinks; stopping one host removes only that target
on the next ~30s discovery poll while the other stays connected.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## RDD-03 — Discovery opt-out and hard devtunnel disable

- **ID:** RDD-03
- **Feature / phase:** Remote discovery — `remote.discover` and
  `CLIMON_DISABLE_DEVTUNNEL` guards.
- **Preconditions:** At least one live host from RDD-01. Devbox has no explicit
  `remote.tunnelId` unless the step says to set one.
- **Config-matrix cell:** Remote / dev-tunnel, discovery disabled
- **Platforms:** macOS, Linux, Windows (devbox)

**Steps:**
1. On the devbox, run `climon config remote.discover false`.
2. Start a new devbox session without setting `remote.tunnelId`.
3. Set an explicit tunnel id for Host A with `climon config remote.tunnelId <id>`
   and start another session.
4. In a fresh shell, set `CLIMON_DISABLE_DEVTUNNEL=1` and start an uplink/session.

**Expected:** Step 2 does not discover or connect to hosts. Step 3 connects only
to the explicit target. Step 4 performs no devtunnel list/connect/show/port
interaction and no discovered or explicit devtunnel connection is made.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |
