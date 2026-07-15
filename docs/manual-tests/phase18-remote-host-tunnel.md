# Remote host self-managed ingest tunnel

Manual checks for the host-side dev-tunnel lifecycle: climon should create or
reuse one stable, labeled ingest tunnel when `feature.remotes` is enabled.

## RHT-01 — Host creates a stable labeled ingest tunnel

- **ID:** RHT-01
- **Feature / phase:** Remote host self-managed ingest tunnel
- **Preconditions:** A host machine with climon, `climon-server`, and the
  `devtunnel` CLI installed and logged in (`devtunnel user show`). No climon
  server is currently running. Use a non-production dev-tunnel account if
  possible.
- **Config-matrix cell:** Remote / dev-tunnel, host auto-managed ingest tunnel
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. On the host, run `climon config feature.remotes enabled`.
2. Start the dashboard with `climon server`.
3. Run `devtunnel list --labels climon-ingest --json`.
4. Find the climon tunnel for this machine and note its `tunnelId`.
5. Verify the id starts with `climon-ingest-`, `hostConnections` is at least `1`,
   and the JSON description has `app: "climon"`, `role: "ingest"`, `clientId`,
   `hostname`, and `version`.
6. Verify the description does not contain `remote.spawnSecret`, `token`,
   `secret`, or credentials.

**Expected:** Exactly one live climon ingest tunnel for the host is listed with
the `climon-ingest` label, an opaque stable id, and only non-secret display
metadata.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## RHT-02 — Host reuses the same tunnel across restarts

- **ID:** RHT-02
- **Feature / phase:** Remote host self-managed ingest tunnel
- **Preconditions:** RHT-01 passed and the original `tunnelId` is recorded.
- **Config-matrix cell:** Remote / dev-tunnel, host restart / tunnel reuse
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Stop the dashboard server normally.
2. Start it again with `climon server`.
3. Run `devtunnel list --labels climon-ingest --json`.
4. Compare the live climon ingest tunnel id with the id recorded in RHT-01.

**Expected:** The same `climon-ingest-…` tunnel id is reused after restart; no
new climon ingest tunnel is created for the host.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |
