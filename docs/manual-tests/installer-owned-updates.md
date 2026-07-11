# Installer-owned cross-platform updates

These checks cover the installer-owned update model: the client updater only
checks, downloads, verifies, and safely stages a release, then hands the verified
staging directory to the new release's own `install[.exe]` through the stable
`--apply-update-v1` protocol. The installer exclusively validates content, places
the client/server binaries, migrates legacy layouts, and cleans up.

They also cover the **signed universal bootstrap** that repairs already-installed
legacy clients (Windows/macOS/Linux) directly to the current installer-owned
layout with no intermediate bridge release. A legacy client copies the new
`install[.exe]` over its own `climon[.exe]` only after verifying the Ed25519
signature over the complete release ZIP (first signed hop); the renamed binary
then dispatches by basename into recovery-bootstrap mode, independently
re-downloads the canonical release, and re-verifies its signature (second signed
hop) before extracting or executing anything.

No configuration matrix applies beyond platform coverage.

> **Automated coverage:** `scripts/upgrade-test-harness.ts` automates the
> cross-platform legacy→current migration and current stub→stub update paths on
> real Windows/macOS/Linux hosts. It builds the actual released **v3.1.3** updater
> (commit `3aca69df1420ff4954c4348ccea01980cb681635`) from a detached worktree,
> uses a throwaway Ed25519 key, and serves a loopback manifest via the dev-only
> `test-update-endpoint` feature; the production signing key and release pipeline
> are never involved. Run it with `bun scripts/upgrade-test-harness.ts`. Its unit
> companion is `tests/upgrade-harness.test.ts`. The cases below remain the manual
> source of truth; the harness scenarios map onto them as follows:
>
> - **Scenario 1** (first-hop tamper rejection) → **MT-IOU-06**.
> - **Scenario 2** (released legacy updater copies installer over `climon`) →
>   the first-hop half of **MT-IOU-02**, **MT-IOU-04**, and **MT-IOU-05**.
> - **Scenario 3** (bootstrap tamper rejection) → **MT-IOU-07**.
> - **Scenario 4** (bootstrap success + current-layout recovery) → the recovery
>   half of **MT-IOU-02**, **MT-IOU-04**, and **MT-IOU-05**.
> - **Scenario 5** (current C→C+1 update) → **MT-IOU-09**.
> - **Scenario 6** (offline bootstrap recovery) → **MT-IOU-08**.

---

## MT-IOU-01 — Fresh install archive and platform layout

- **ID:** MT-IOU-01
- **Feature / phase:** Installer-owned updates — fresh install layout
- **Preconditions:** A release/staging archive for this platform containing
  exactly `install[.exe]`, the client payload (`climon` on Unix, `climon.dll` on
  Windows), and `climon-server[.exe]`; scratch `HOME`/`LOCALAPPDATA` and
  `CLIMON_HOME` so no real install is touched.
- **Config-matrix cell:** n/a
- **Platforms:** Windows, macOS, Linux

**Steps:**
1. Extract the platform zip into a scratch staging directory.
2. Run the installer from the staging directory (`install.exe` on Windows,
   `./install` on Unix).
3. List the resolved install directory.
4. Inspect the pointer files on Windows (`climon.version`,
   `climon-server.version`).
5. From a fresh shell on PATH, run `climon --version` and `climon server --help`.

**Expected result:**
- The zip contains only `install[.exe]`, the client payload, and
  `climon-server[.exe]`; there is no separate standalone Windows client beside the
  DLL and no `climon-alpha` sentinel entry.
- On **Windows**, the install dir contains the stable stubs `climon.exe` and
  `climon-server.exe`, the versioned payloads `climon-<version>.dll` and
  `climon-server-<version>.exe`, and both `climon.version` /
  `climon-server.version` pointers set to the installed version.
- On **macOS/Linux**, the install dir contains the executable `climon` and
  `climon-server` binaries and a `.version` file with the installed version.
- User PATH points at the install directory, and `climon --version` /
  `climon server --help` run through the installed layout.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-IOU-02 — Real pre-change Windows release migrates directly to current, rerun required

- **ID:** MT-IOU-02
- **Feature / phase:** Installer-owned updates — Windows signed bootstrap recovery
- **Preconditions:** A **real** already-released pre-change Windows install
  (single `climon.exe`, no `climon.version` pointer — e.g. v3.1.3); the updater
  pointed at a signed current release ("C") whose zip contains `install.exe`,
  `climon.dll`, and `climon-server.exe`; scratch `CLIMON_HOME`. No intermediate
  bridge release is involved.
- **Config-matrix cell:** n/a
- **Platforms:** Windows

**Steps:**
1. Confirm the install dir is legacy: single `climon.exe`, no `climon.version`.
2. Run `climon update` (the released pre-change updater).
3. Observe the console output of this first-hop copy.
4. Run `climon --version` from a fresh shell (this runs the renamed bootstrap),
   read the printed message, and note that no window pops up for the detached
   recovery process it spawns.
5. Follow the prompt and rerun `climon --version` (or `climon update`).
6. List the install dir and inspect both pointer files.

**Expected result:**
- The released updater verifies the Ed25519 signature over the complete release
  ZIP (including `install.exe`) before copying `install.exe` over `climon.exe`
  (first signed hop).
- On the next run, the renamed binary dispatches by basename into
  recovery-bootstrap mode, independently re-downloads and re-verifies the
  canonical release (second signed hop), then spawns a detached recovery process
  (no console window, null stdio) that waits for the exact bootstrap PID to exit
  before mutating files.
- The recovery installer prints, verbatim:

  ```text
  A critical climon update was applied successfully.
  Please rerun your climon command.
  ```

  and does **not** automatically resume the original command.
- After rerunning, the install dir has the stub layout — `climon.exe` stub,
  `climon-<C>.dll`, `climon-server.exe` stub, `climon-server-<C>.exe`, and both
  pointer files on version C — and `climon.exe.old` is retained as a fallback.
  PATH is unchanged.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-IOU-03 — Windows `.old` fallback and non-recursive `update`

- **ID:** MT-IOU-03
- **Feature / phase:** Installer-owned updates — Windows fallback + no recursion
- **Preconditions:** A real pre-change Windows install that has completed the
  first signed hop (its `climon.exe` is now the bootstrap and `climon.exe.old`
  holds the prior client); a way to make the bootstrap redownload/verify/stage or
  child launch fail (e.g. disconnect networking); access to `install.ps1`.
- **Config-matrix cell:** n/a
- **Platforms:** Windows

**Steps:**
1. With the bootstrap unable to complete recovery, run a **normal** command such
   as `climon --version`.
2. Observe which binary handles it and the exit behavior.
3. Separately, run `climon update` under the same failure condition and observe
   the output.
4. Rename or delete `climon.exe.old`, then run `climon --version` again.

**Expected result:**
- When the bootstrap cannot run and `climon.exe.old` is present, a **normal**
  command falls back to the locally derived `<dir>\climon.exe.old` with the
  original arguments and returns its exit code.
- For an original `update` command, the bootstrap returns a clear, retryable
  error and **never** invokes the old updater recursively.
- When `climon.exe.old` is missing, the bootstrap is retained and guidance
  instructs the user to re-run `install.ps1`; the command returns non-zero.
- The `.old` fallback path is always the resolved `<install-dir>\climon.exe.old`,
  never a manifest-supplied path.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-IOU-04 — Real pre-change macOS release migrates directly to current, command resumes

- **ID:** MT-IOU-04
- **Feature / phase:** Installer-owned updates — macOS signed bootstrap recovery
- **Preconditions:** A **real** already-released pre-change macOS install
  (installed `climon` and `climon-server`, no `.version`); the updater pointed at
  a signed current release C whose zip contains `install`, `climon`, and
  `climon-server`; scratch `CLIMON_HOME`; network available.
- **Config-matrix cell:** n/a
- **Platforms:** macOS

**Steps:**
1. Confirm the install is the legacy Unix layout.
2. Run a command through the released updater, e.g. `climon update`.
3. Observe whether the command completes without a manual rerun.
4. List the install dir and inspect `.version`.
5. Start a new monitored `climon` session and open the dashboard.

**Expected result:**
- The released Unix updater verifies the signature over the complete ZIP, then
  atomically renames `install` over `climon` (first signed hop).
- The renamed binary dispatches into recovery-bootstrap mode, independently
  re-downloads and re-verifies the canonical release (second signed hop), invokes
  staged `install --recover-bootstrap-v1`, and lets the installer apply the
  current Unix layout via rename-over.
- Recovery is **synchronous**: the bootstrap then launches `<dir>/climon` with the
  user's original arguments and returns its exact exit code (128+signal on signal
  death), so the original command resumes automatically with no rerun prompt.
- The install dir has the current Unix layout (`climon`, `climon-server`,
  `.version` = C) and new sessions appear on the dashboard.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-IOU-05 — Real pre-change Linux release migrates directly to current, command resumes

- **ID:** MT-IOU-05
- **Feature / phase:** Installer-owned updates — Linux signed bootstrap recovery
- **Preconditions:** A **real** already-released pre-change Linux install
  (installed `climon` and `climon-server`, no `.version`); the updater pointed at
  a signed current release C whose zip contains `install`, `climon`, and
  `climon-server`; scratch `CLIMON_HOME`; network available.
- **Config-matrix cell:** n/a
- **Platforms:** Linux

**Steps:**
1. Confirm the install is the legacy Unix layout.
2. Run a command through the released updater, e.g. `climon update`.
3. Observe whether the command completes without a manual rerun.
4. List the install dir and inspect `.version`.
5. Start a new monitored `climon` session and open the dashboard.

**Expected result:**
- Same as MT-IOU-04 on Linux: first signed hop (rename `install` over `climon`),
  second signed hop (independent re-download + re-verify), then staged
  `install --recover-bootstrap-v1` applies the current Unix layout via
  rename-over.
- Recovery is **synchronous**: the bootstrap launches `<dir>/climon` with the
  original arguments and returns its exact exit code (128+signal on signal
  death), so the original command resumes automatically with no rerun prompt.
- The install dir has the current Unix layout (`climon`, `climon-server`,
  `.version` = C) and new sessions appear on the dashboard.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-IOU-06 — First-hop tampered archive rejected by the legacy client

- **ID:** MT-IOU-06
- **Feature / phase:** Installer-owned updates — first signed hop integrity
- **Preconditions:** A real pre-change legacy install (Windows or Unix); a served
  current release whose `.zip` bytes have been tampered while the `.sig` still
  references the original, or a valid `.sig` for different bytes; scratch
  `CLIMON_HOME`. Automated: `scripts/upgrade-test-harness.ts` Scenario 1.
- **Config-matrix cell:** n/a
- **Platforms:** Windows, macOS, Linux

**Steps:**
1. Point the released legacy updater at the tampered current archive.
2. Run `climon update`.
3. Inspect the install dir and the printed status.

**Expected result:**
- The legacy client verifies the Ed25519 signature over the complete release ZIP
  (which includes `install[.exe]`) and **rejects** the tampered archive before
  extracting or copying anything.
- No file is mutated: `climon[.exe]` is untouched, no bootstrap is installed, and
  no `climon.exe.old` is created.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-IOU-07 — Bootstrap tampered redownload rejected before execution

- **ID:** MT-IOU-07
- **Feature / phase:** Installer-owned updates — second signed hop integrity
- **Preconditions:** An install where the first signed hop has completed so
  `climon[.exe]` is now the bootstrap; the canonical release endpoint serves a
  tampered `.zip` (or mismatched `.sig`) for the bootstrap's redownload; scratch
  `CLIMON_HOME`. Automated: `scripts/upgrade-test-harness.ts` Scenario 3.
- **Config-matrix cell:** n/a
- **Platforms:** Windows, macOS, Linux

**Steps:**
1. Run any command so the bootstrap performs its recovery redownload.
2. Observe the outcome and the install dir.

**Expected result:**
- The bootstrap independently verifies the Ed25519 signature over the freshly
  downloaded canonical archive with the embedded update public key and **refuses**
  to extract or execute any content when verification fails.
- No staged installer is executed and the installation is not mutated by the
  failed hop; the bootstrap surfaces a clear failure (and, on Windows, follows the
  MT-IOU-03 fallback rules).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-IOU-08 — Unix offline network guidance for the one-time migration

- **ID:** MT-IOU-08
- **Feature / phase:** Installer-owned updates — Unix offline bootstrap guidance
- **Preconditions:** A real pre-change macOS or Linux install that has completed
  the first signed hop (its `climon` is now the bootstrap); no network
  connectivity to the canonical release endpoint; scratch `CLIMON_HOME`.
  Automated: `scripts/upgrade-test-harness.ts` Scenario 6.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux

**Steps:**
1. With networking disabled, run any command so the bootstrap attempts recovery.
2. Read the printed message.
3. Re-run the same command and confirm the same network-required guidance is
   printed again — it is re-staged, fails, and re-printed on every offline run
   (there is no dedupe/"already shown" state).
4. Inspect the install dir.

**Expected result:**
- On every offline run the bootstrap re-stages, fails, and re-prints the same
  guidance: that the one-time critical migration **requires a network connection**
  and that re-running `install.sh` is the manual recovery path. The word
  "one-time" describes the migration, not the message frequency — the guidance is
  not deduplicated across runs.
- The installation is **not** partially mutated before verification and staging
  complete (no rename-over occurs on the offline failure path).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-IOU-09 — Current C-to-C+1 update delegates to the installer while sessions stay alive

- **ID:** MT-IOU-09
- **Feature / phase:** Installer-owned updates — versioned installer delegation
- **Preconditions:** A current installer-owned install at version C (Windows stub
  layout or Unix layout); a signed release C+1; at least two attached, long-lived
  `climon` sessions running from C; scratch `CLIMON_HOME`. Automated:
  `scripts/upgrade-test-harness.ts` Scenario 5.
- **Config-matrix cell:** n/a
- **Platforms:** Windows, macOS, Linux

**Steps:**
1. Start two or more monitored sessions from separate terminals and keep them
   attached.
2. In another terminal, run `climon update` pointed at C+1.
3. Observe the update output.
4. List the install dir and inspect the pointer/`.version` files.
5. Confirm the attached sessions keep running, then start a new
   `climon --version` / monitored session.

**Expected result:**
- `climon update` performs only check → download → verify → safe stage → invoke
  the C+1 `install[.exe]` via `--apply-update-v1 --dir <installdir> --source
  <staged> --version <C+1>`; the installer owns placement/migration/cleanup.
- On **Windows** the install keeps the stable stubs, gains `climon-<C+1>.dll` and
  `climon-server-<C+1>.exe`, and flips both pointers to C+1; on **Unix** the
  installer replaces `climon`/`climon-server` via rename-over and updates
  `.version` to C+1.
- Already-attached sessions continue on version C uninterrupted; new launches
  after the update use C+1. The update never kills a running session or daemon.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-IOU-10 — Production binary ignores the test manifest environment variable

- **ID:** MT-IOU-10
- **Feature / phase:** Installer-owned updates — test-endpoint isolation
- **Preconditions:** A **production** `climon` build produced by the default
  `scripts/compile.ts` path / `.github/workflows/release.yml` (i.e. built without
  `CLIMON_TEST_UPDATE_ENDPOINT=1`, so the `test-update-endpoint` cargo feature and
  the `CLIMON_UPDATE_PUBKEY_B64` override are compiled out); a loopback manifest
  server; scratch `CLIMON_HOME`.
- **Config-matrix cell:** n/a
- **Platforms:** Windows, macOS, Linux

**Steps:**
1. Set `CLIMON_TEST_MANIFEST_URL` to the loopback manifest server URL.
2. Run `climon update` (or `climon __update-check`).
3. Observe which endpoint the client contacts.

**Expected result:**
- The production build **ignores** `CLIMON_TEST_MANIFEST_URL` entirely and only
  ever resolves the canonical
  `https://github.com/jackgeek/climon/releases/latest/download/manifest.json`
  endpoint.
- The shipped binary physically lacks the pubkey override and always embeds the
  real update public key. `.github/workflows/release.yml` never sets
  `CLIMON_TEST_UPDATE_ENDPOINT` or enables `test-update-endpoint` (pinned by
  `tests/upgrade-harness.test.ts`).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
