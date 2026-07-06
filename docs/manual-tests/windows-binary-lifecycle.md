# Windows binary lifecycle

These checks cover the dedicated `install[.exe]` crate, Windows stub +
versioned-artifact layout, Windows-safe updates while binaries are locked, Unix
copy/update parity, and removal of the old `climon-alpha` sentinel self-install
path.

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
