# Windows binary lifecycle

These checks cover the dedicated `install[.exe]` crate, Windows stub +
versioned-artifact layout, Unix source-name copy behavior, removal of the old
`climon-alpha` sentinel self-install path, and bridge `--migrate` conversion.

No configuration matrix applies beyond platform coverage.

---

## MT-WBL-01 — Release zip uses dedicated installer and Windows stub layout

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

**Expected result:**
- The zip contains `install.exe`, `climon.dll`, and `climon-server.exe`; it does
  not require separate stub zip entries.
- The install dir contains `climon.exe`, `climon-server.exe`,
  `climon-<version>.dll`, `climon-server-<version>.exe`, `climon.version`, and
  `climon-server.version`.
- Both pointer files contain the installed version, and user PATH points at the
  install dir.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-WBL-02 — Unix install copies `climon` without rename

- **ID:** MT-WBL-02
- **Feature / phase:** Windows binary lifecycle — Unix installer source names
- **Preconditions:** A release/staging build for macOS or Linux with `install`,
  `climon`, and `climon-server`; scratch `HOME` and `CLIMON_HOME`.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux

**Steps:**
1. Extract the Unix zip into a scratch staging directory.
2. Run `./install --apply` from the staging directory.
3. List the selected install directory.

**Expected result:**
- The install dir contains `climon` copied from the `climon` staging entry, not
  from an `install`→`climon` rename path.
- `climon-server` is present, both installed binaries are executable, and PATH
  setup behaves as before.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-WBL-03 — Bridge migration converts a legacy Windows install

- **ID:** MT-WBL-03
- **Feature / phase:** Windows binary lifecycle — `install.exe --migrate`
- **Preconditions:** A scratch Windows install dir containing a legacy
  `climon.exe`; a staging dir containing `install.exe`, `climon.dll`, and
  `climon-server.exe`.
- **Config-matrix cell:** n/a
- **Platforms:** Windows

**Steps:**
1. Run `install.exe --migrate --dir <install-dir> --source <staging-dir>`.
2. List `<install-dir>`.
3. Run the same command a second time.

**Expected result:**
- The command exits 0 without onboarding prompts or changelog paging.
- The install dir has the same stub/versioned layout as MT-WBL-01.
- Re-running is idempotent and leaves PATH pointing at the install dir.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
