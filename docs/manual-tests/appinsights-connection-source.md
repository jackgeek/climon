# App Insights connection string source

These checks prove that the Azure Application Insights connection string — a
secret — is **never** stored in climon config, and that log forwarding only
happens when the user opts in with `telemetry.enabled` **and** a connection
string is supplied via the `APPLICATIONINSIGHTS_CONNECTION_STRING` environment
variable (or the build-time embedded constant). The removed
`logging.appInsights.connectionString` config key must no longer exist.

Use a scratch `$CLIMON_HOME` so the test does not touch your real `~/.climon`.

---

## MT-AICS-01 — The config key no longer exists

- **ID:** MT-AICS-01
- **Feature / phase:** App Insights connection string source
- **Preconditions:** A built `climon` binary; a scratch `$CLIMON_HOME`.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Run `climon config --help` and inspect the list of settings.
2. Run `climon config logging.appInsights.connectionString "InstrumentationKey=x"`.

**Expected result:**
- `logging.appInsights.connectionString` does **not** appear in `climon config --help`.
- Setting it is rejected as an unknown key (it is not written to `config.jsonc`).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-AICS-02 — Forwarding requires opt-in + env var, and the secret stays out of config

- **ID:** MT-AICS-02
- **Feature / phase:** App Insights connection string source
- **Preconditions:** A built `climon`/`climon-server`; a scratch `$CLIMON_HOME`;
  a real Application Insights connection string.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Run `climon config --global telemetry.enabled true`.
2. Start the dashboard server **without** the env var set and log some activity;
   confirm nothing is forwarded (local logs only).
3. Stop the server. Start it again with
   `APPLICATIONINSIGHTS_CONNECTION_STRING="<connection-string>"` exported, leave
   it running for at least ~30s, then generate some log activity.
4. In Azure, query `traces | where timestamp > ago(30m)` on the resource.
5. Inspect `$CLIMON_HOME/config.jsonc`.

**Expected result:**
- Step 2 forwards nothing (no connection string source ⇒ local-only).
- Step 4 shows forwarded traces, each carrying the anonymous `installId`; secrets
  in properties appear as `[REDACTED:...]`.
- Step 5: `config.jsonc` contains **no** connection string anywhere.
- Setting `telemetry.enabled false` stops forwarding.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---
