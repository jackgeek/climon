# Windows binary lifecycle

These checks cover the dedicated `install[.exe]` crate, Windows stub +
versioned-artifact layout, Windows-safe updates while binaries are locked, Unix
copy/update parity, removal of the old `climon-alpha` sentinel self-install
path, and bridge `--migrate` conversion.

No configuration matrix applies beyond platform coverage.

---

## MT-WBL-01 — Fresh Windows install places stubs, versioned artifacts, and pointers

- **ID:** MT-WBL-01
- **Feature / phase:** Windows binary lifecycle — dedicated installer + stubs
- **Preconditions:** A release/staging build for Windows with `install.exe`,
  `climon.dll`, and `climon-server.exe`; scratch `LOCALAPPDATA` and
  `CLIMON_HOME` so no real install is touched.
- **Config-matrix cell:** n/a
- **Platforms:** Windows

**Steps:**
1. Extract the Windows zip into a scratch staging directory.
2. Run `install.exe --apply` from the staging directory.
3. List `%LOCALAPPDATA%\Programs\climon`.
4. Inspect `climon.version` and `climon-server.version`.
5. Run `climon --version` and `climon server --help` from a fresh shell on PATH.

**Expected result:**
- The zip contains `install.exe`, `climon.dll`, and `climon-server.exe`; it does
  not contain separate stub zip entries or a `climon-alpha` sentinel.
- The install dir contains `climon.exe`, `climon-server.exe`,
  `climon-<version>.dll`, `climon-server-<version>.exe`, `climon.version`, and
  `climon-server.version`.
- Both pointer files contain the installed version, and user PATH points at the
  install dir.
- `climon.exe` is the stable stub and launches the versioned DLL; the server stub
  launches the versioned server payload.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-WBL-02 — Windows update applies while multiple terminals are open

- **ID:** MT-WBL-02
- **Feature / phase:** Windows binary lifecycle — locked executable update
- **Preconditions:** A scratch Windows install using the stub layout at version
  A; a signed update/staging manifest for version B; at least two interactive
  terminals running long-lived `climon` sessions from version A.
- **Config-matrix cell:** n/a
- **Platforms:** Windows

**Steps:**
1. Start two or more monitored sessions from separate terminals and keep them
   attached.
2. In another terminal, point `climon update` at the version B manifest/staging
   release and run it.
3. List the install directory and inspect `climon.version` and
   `climon-server.version`.
4. Confirm the original attached terminals continue running.
5. Detach or exit one original terminal, then start a new `climon --version` or
   monitored session.

**Expected result:**
- `climon update` applies without reporting a locked-file deferral for
  `climon.exe` or `climon-server.exe`.
- The install dir keeps the stable stubs, gains `climon-<B>.dll` and
  `climon-server-<B>.exe`, and flips both pointer files to version B.
- Already-open terminals continue with version A until they exit.
- New launches after the pointer flip use version B.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-WBL-03 — `climon cleanup` reaps unlocked superseded Windows payloads

- **ID:** MT-WBL-03
- **Feature / phase:** Windows binary lifecycle — superseded payload reaper
- **Preconditions:** A scratch Windows stub-layout install with current version C
  plus superseded `climon-<old>.dll` and `climon-server-<old>.exe` files; one
  superseded DLL is still locked by an open climon terminal and at least one
  superseded file is unlocked.
- **Config-matrix cell:** n/a
- **Platforms:** Windows

**Steps:**
1. List the install directory before cleanup and note current pointer values.
2. Run `climon cleanup`.
3. List the install directory again.
4. Close the terminal that was locking the old DLL.
5. Run `climon cleanup` a second time and list the install directory again.

**Expected result:**
- Cleanup removes superseded versioned files that are not locked.
- Cleanup skips locked superseded files without failing the overall command.
- Pointer files and current versioned payloads remain intact.
- After the locking terminal exits, a later cleanup removes the formerly locked
  superseded file.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-WBL-04 — Windows stubs fall back when pointer files are missing or corrupt

- **ID:** MT-WBL-04
- **Feature / phase:** Windows binary lifecycle — pointer fallback
- **Preconditions:** A scratch Windows stub-layout install containing at least two
  valid versioned client DLLs and server executables, for example versions A and
  B where B is the highest semver.
- **Config-matrix cell:** n/a
- **Platforms:** Windows

**Steps:**
1. Replace `climon.version` with invalid text and run `climon --version`.
2. Delete `climon.version` and run `climon --version` again.
3. Repeat the corrupt and missing-pointer checks for `climon-server.version` by
   launching `climon server --help` or starting the dashboard in the scratch
   environment.
4. Restore both pointer files to the intended current version.

**Expected result:**
- The client stub ignores the corrupt or missing pointer and loads the
  highest-semver `climon-*.dll`.
- The server stub ignores the corrupt or missing pointer and launches the
  highest-semver `climon-server-*.exe`.
- Restoring pointer files returns launches to the explicit pointed version.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-WBL-05 — Legacy-layout Windows upgrade replaces the single client with the stub

- **ID:** MT-WBL-05
- **Feature / phase:** Windows binary lifecycle — legacy layout upgrade
- **Preconditions:** A scratch Windows install dir that represents the old layout:
  a single installed `climon.exe`, installed `climon-server.exe`, no
  `climon.version`, and PATH already pointing at that directory; a staging build
  for a stub-layout release.
- **Config-matrix cell:** n/a
- **Platforms:** Windows

**Steps:**
1. Run the stub-layout installer or update path that upgrades the scratch legacy
   install.
2. List the install directory.
3. Inspect whether the previous client was preserved as `climon.exe.old` when the
   migration path applies.
4. Run `climon --version` and start a simple monitored command from a fresh shell.

**Expected result:**
- The old single `climon.exe` client is replaced by the stable stub layout.
- The install dir contains `climon.exe` stub, `climon-<version>.dll`,
  `climon-server.exe` stub, `climon-server-<version>.exe`, `climon.version`, and
  `climon-server.version`.
- PATH remains pointed at the same install directory.
- New launches work through the stub and monitored sessions still appear in the
  dashboard.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-WBL-06 — Unix install copies `climon` and update keeps rename-over swap

- **ID:** MT-WBL-06
- **Feature / phase:** Windows binary lifecycle — Unix installer source names
- **Preconditions:** A release/staging build for macOS or Linux with `install`,
  `climon`, and `climon-server`; scratch `HOME` and `CLIMON_HOME`; optional
  signed update/staging manifest for a newer version.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux

**Steps:**
1. Extract the Unix zip into a scratch staging directory.
2. Run `./install --apply` from the staging directory.
3. List the selected install directory.
4. If an update staging release is available, keep a `climon` session running and
   run `climon update` to the newer Unix release.

**Expected result:**
- The install dir contains `climon` copied from the `climon` staging entry, not
  from an `install`→`climon` rename path.
- `climon-server` is present, both installed binaries are executable, and PATH
  setup behaves as before.
- Unix updates continue to use the existing rename-over swap behavior; no Windows
  stub, DLL, or pointer files are created.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-WBL-07 — Legacy Windows install auto-updates to the bridge release

- **ID:** MT-WBL-07
- **Feature / phase:** Windows binary lifecycle — bridge rollout migration
- **Preconditions:** A real or scratch legacy Windows install with a single
  installed `climon.exe`, no `climon.version` pointer, auto-update or manual
  update configured to use a bridge manifest, and the bridge release still using
  legacy packaging.
- **Config-matrix cell:** n/a
- **Platforms:** Windows

**Steps:**
1. Confirm the install directory has no `climon.version` and no
   `climon-<version>.dll`.
2. Point the updater at the bridge release manifest.
3. Run `climon update`.
4. Open several terminals and run monitored `climon` sessions.
5. List the install directory after the update.

**Expected result:**
- The update succeeds through the existing legacy update path.
- The install is still a working legacy layout with a single bridge
  `climon.exe`; no stub, `climon.dll`, or pointer file is installed yet.
- Multiple monitored terminals continue to work and appear in the dashboard.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-WBL-08 — Bridge install migrates to the first stub release C

- **ID:** MT-WBL-08
- **Feature / phase:** Windows binary lifecycle — bridge-to-stub migration
- **Preconditions:** The bridge install produced by MT-WBL-07; a signed manifest
  for the first stub release C whose zip contains `install.exe`, `climon.dll`,
  and `climon-server.exe`.
- **Config-matrix cell:** n/a
- **Platforms:** Windows

**Steps:**
1. Point the updater at C's manifest.
2. Run `climon update` from the bridge install.
3. Capture the update output.
4. List the install directory and inspect `climon.version` and
   `climon-server.version`.
5. Start a new monitored terminal and open the dashboard.

**Expected result:**
- `climon update` reports that it is migrating the install to the new binary
  layout (the message may include the target version).
- The install dir gains `climon.exe` stub, `climon-<C>.dll`,
  `climon-server.exe` stub, `climon-server-<C>.exe`, `climon.version`, and
  `climon-server.version`.
- The old client is moved to `climon.exe.old`.
- PATH remains pointed at the same install directory.
- New terminals run through the stub and monitor correctly.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-WBL-09 — Legacy install that skips the bridge has the documented recovery path

- **ID:** MT-WBL-09
- **Feature / phase:** Windows binary lifecycle — documented bridge skip case
- **Preconditions:** A legacy Windows install that never received the bridge
  release; an update path pointed straight at the first stub release C; access to
  the current `install.ps1` installer.
- **Config-matrix cell:** n/a
- **Platforms:** Windows

**Steps:**
1. Confirm the install directory is legacy: single `climon.exe`, no
   `climon.version` pointer.
2. Run the pre-bridge `climon update` path directly to C.
3. Attempt `climon --version` from a fresh shell and record the failure.
4. Re-run `install.ps1` for the same release/install directory.
5. Run `climon --version` and start a simple monitored command.

**Expected result:**
- The direct legacy-to-C update is a documented failure: the old updater copies
  C's dedicated installer over `climon.exe`, so normal `climon` launches are
  bricked.
- Re-running `install.ps1` restores a working stub layout via the installer's
  legacy-upgrade path.
- After reinstall, the layout matches MT-WBL-01 and monitored sessions work.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-WBL-10 — `install.exe --migrate` is idempotent

- **ID:** MT-WBL-10
- **Feature / phase:** Windows binary lifecycle — `install.exe --migrate`
- **Preconditions:** A scratch Windows install dir containing a legacy or already
  migrated install; a staged C directory containing `install.exe`, `climon.dll`,
  and `climon-server.exe`.
- **Config-matrix cell:** n/a
- **Platforms:** Windows

**Steps:**
1. Run `install.exe --migrate --dir <install-dir> --source <staged-C>`.
2. List `<install-dir>` and record pointer-file contents.
3. Run the same command a second time.
4. List `<install-dir>` and compare with the first run.

**Expected result:**
- Each command exits 0 without onboarding prompts or changelog paging.
- The first run creates or refreshes the same stub/versioned layout as MT-WBL-01.
- The second run re-places the same version without error, leaves pointer files
  on the staged C version, and does not disturb PATH.
- The layout is unchanged except for expected replacement timestamps.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
