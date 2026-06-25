# Phase 14 — WSL bridge feature flag

Manual checks for the config-driven remote ingest startup and the separate
Windows/WSL bridge opt-in. These cases prove `feature.remotes` can enable
devbox ingest without enabling the same-machine WSL bridge, and that
`feature.wslBridge` is the only switch that activates peer uplinks and cross-OS
dashboard handoff.

| Cell | Scenario | Notes |
|---|---|---|
| WSL-FLAG-LINK | Explicit Windows/WSL opt-in | `climon link` prompt or `--wsl-bridge`. |
| WSL-AUTO-LINK | Discovery-only auto-link | First non-interactive WSL run. |
| RMT-CONFIG | Devbox remotes | `feature.remotes` starts ingest; no CLI flag. |
| WSL-ISOLATION | Remotes on, bridge off | Proves the two flags are independent. |
| WSL-NON-TTY | Automation defaults | Non-TTY link leaves bridge off unless explicit. |
| WSL-X1 | Interim Windows exposure warning | Operator-only reminder for workstream ordering. |

---

## MT-P14-01 — `climon link` enables the bridge on both sides

- **ID:** MT-P14-01
- **Feature / phase:** WSL bridge feature flag — explicit link opt-in
- **Preconditions:** Windows host with WSL installed; climon installed on both
  Windows and WSL; fresh or isolated `CLIMON_HOME` on both sides.
- **Config-matrix cell:** WSL-FLAG-LINK
- **Platforms:** Windows + WSL

**Steps:**
1. Start the Windows dashboard with `climon server`.
2. In WSL from a TTY, run `climon link`.
3. Answer **yes** to `Enable the WSL bridge so sessions appear on the shared dashboard?`.
4. Inspect both configs with `climon config --debug` (or by reading each
   `config.jsonc`) and confirm `feature.wslBridge` is `enabled` on both sides.
5. Confirm the command prints the restart/next-session notice:
   `WSL bridge enabled ... Restart climon (or start your next session) for it to take effect.`
6. Restart `climon server` on Windows, then start a WSL session such as
   `climon bash`.
7. Open the Windows dashboard and watch the WSL session.

**Expected result:** `climon link` writes `remote.peerHome` and
`feature.wslBridge enabled` on both sides, prints the restart notice, and after
restart the WSL session appears and streams on the shared dashboard.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P14-02 — Auto-link wires discovery only

- **ID:** MT-P14-02
- **Feature / phase:** WSL bridge feature flag — auto-link opt-in boundary
- **Preconditions:** Windows host with WSL installed; climon installed on both
  sides; `remote.autoLink` unset or `true`; `remote.peerHome` and
  `feature.wslBridge` unset/disabled on both sides.
- **Config-matrix cell:** WSL-AUTO-LINK
- **Platforms:** Windows + WSL

**Steps:**
1. Ensure the Windows `CLIMON_HOME` exists, then run a first WSL climon command
   in a non-interactive context that triggers `maybe_auto_link` (for example the
   automation harness used for release testing).
2. Inspect the WSL and Windows configs.
3. Capture the command output.
4. Start `climon server` on Windows and a WSL session without enabling
   `feature.wslBridge`.

**Expected result:** Auto-link writes `remote.peerHome` on both sides, leaves
`feature.wslBridge` disabled on both sides, and prints that discovery was
configured but the WSL bridge is not enabled until opt-in. The WSL session does
not stream to the Windows dashboard until `feature.wslBridge` is enabled.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P14-03 — `feature.remotes` starts ingest with no CLI flag

- **ID:** MT-P14-03
- **Feature / phase:** WSL bridge feature flag — config-driven remotes ingest
- **Preconditions:** Isolated `CLIMON_HOME`; no running climon dashboard,
  ingest, or uplink processes.
- **Config-matrix cell:** RMT-CONFIG
- **Platforms:** Linux/macOS/Windows

**Steps:**
1. Run `climon config feature.remotes enabled`.
2. Start the dashboard with `climon server` and no remotes CLI flag.
3. Inspect `$CLIMON_HOME/ingest.json`.
4. Request `GET http://127.0.0.1:<dashboard-port>/health`.

**Expected result:** The server starts the ingest daemon solely from config,
`ingest.json` appears with a live pid/host/port, `/health` reports
`remotesEnabled: true`, and `ports.ingest` is present.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P14-04 — Removed `--enable-remotes` has no effect

- **ID:** MT-P14-04
- **Feature / phase:** WSL bridge feature flag — removed server flag
- **Preconditions:** Isolated `CLIMON_HOME`; `feature.remotes` and
  `feature.wslBridge` unset/disabled; no running climon dashboard, ingest, or
  uplink processes.
- **Config-matrix cell:** RMT-CONFIG
- **Platforms:** Linux/macOS/Windows

**Steps:**
1. Run `climon server --enable-remotes`.
2. Request `GET http://127.0.0.1:<dashboard-port>/health`.
3. Inspect `$CLIMON_HOME` for `ingest.json`.
4. Stop the server, run `climon config feature.remotes enabled`, then start
   `climon server` with no removed flag.

**Expected result:** `climon server --enable-remotes` starts normally for
backward tolerance, but the removed flag does not enable ingest:
`remotesEnabled` stays `false` and no `ingest.json` appears. After enabling
`feature.remotes` in config and restarting without the flag, ingest starts and
`remotesEnabled` becomes `true`.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P14-05 — Remotes on, WSL bridge off stays isolated

- **ID:** MT-P14-05
- **Feature / phase:** WSL bridge feature flag — remotes/bridge isolation
- **Preconditions:** Windows host with WSL installed; climon installed on both
  sides; `remote.peerHome` configured on both sides; no running climon dashboard,
  ingest, or uplink processes.
- **Config-matrix cell:** WSL-ISOLATION
- **Platforms:** Windows + WSL

**Steps:**
1. On the dashboard side, run `climon config feature.remotes enabled`.
2. On both sides, run `climon config feature.wslBridge disabled`.
3. Start `climon server` on Windows.
4. Start a WSL session with `climon bash`.
5. Check processes/logs and the dashboard: no peer `climon __uplink` should be
   spawned, and server startup should not log/run cross-OS promote.
6. Stop the session/server, enable the bridge on both sides with
   `climon config feature.wslBridge enabled`, then restart `climon server` and a
   WSL session.

**Expected result:** With `feature.remotes=enabled` and
`feature.wslBridge=disabled`, the devbox ingest can run but same-machine peer
uplink and cross-OS promote remain inactive. Enabling `feature.wslBridge`
activates peer bridging and the WSL session appears on the shared dashboard.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P14-06 — Non-TTY `climon link` defaults the bridge off

- **ID:** MT-P14-06
- **Feature / phase:** WSL bridge feature flag — non-interactive link default
- **Preconditions:** Windows host with WSL installed; climon installed on both
  sides; fresh or isolated `CLIMON_HOME` on both sides.
- **Config-matrix cell:** WSL-NON-TTY
- **Platforms:** Windows + WSL

**Steps:**
1. From WSL, run `climon link` with stdin not connected to a TTY and without
   `--wsl-bridge` or `--no-wsl-bridge` (for example from a script).
2. Inspect both configs.
3. Confirm output states: `No TTY detected; the WSL bridge is left disabled`.
4. Re-run from the same non-TTY context with `climon link --wsl-bridge`.
5. Inspect both configs again.

**Expected result:** The first non-TTY run writes discovery but leaves
`feature.wslBridge` disabled and says it was not enabled. The second run with
`--wsl-bridge` enables `feature.wslBridge` on both sides.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P14-07 — Interim WSL exposure warning (X1)

- **ID:** MT-P14-07
- **Feature / phase:** WSL bridge feature flag — interim exposure warning
- **Preconditions:** Windows host with WSL installed; climon installed on
  Windows; isolated `CLIMON_HOME`; `feature.remotes` disabled/unset after the
  test cleanup.
- **Config-matrix cell:** WSL-X1
- **Platforms:** Windows with WSL installed

**Steps:**
1. On Windows, run `climon config feature.remotes enabled`.
2. Run `climon config feature.wslBridge disabled`.
3. Start `climon server` and capture startup output.
4. Confirm `ingest.json` publishes the `vEthernet (WSL)` interface address.
5. Read the startup warning.

**Expected result:** Startup warns that ingest is listening on the
`vEthernet (WSL)` interface while the WSL bridge is disabled, and that the
transport guard (gate #3) ships with the ingest cutover. Operator reminder: do
not roll B out to users ahead of workstream A.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_
