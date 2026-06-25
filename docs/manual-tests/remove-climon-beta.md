# Remove `climon-beta` from the distribution

These checks prove that the dead in-process `climon-beta` server bundle is no
longer built, packaged, or installed, and that updating an existing install
removes any orphaned `climon-beta` left over from a previous version. The
shipped Rust `climon` client always spawns the standalone `climon-server`
binary, so dropping `climon-beta` must not change client or server behaviour.

No configuration matrix applies beyond platform coverage.

---

## MT-RB-01 — Release zip and fresh install contain no `climon-beta`

- **ID:** MT-RB-01
- **Feature / phase:** Remove `climon-beta` from the distribution
- **Preconditions:** A clean checkout with Bun available; use a scratch
  `$CLIMON_HOME` and a scratch install directory under the project workspace so
  the test does not touch your real `~/.climon` or `~/.local/bin`.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Build the release artifacts: `bun run compile`.
2. Inspect the per-platform zip in `dist/` for your platform (e.g.
   `unzip -l dist/climon-darwin-arm64.zip`).
3. Confirm the archive contains exactly three entries: `install`
   (`install.exe` on Windows), `climon-server` (`climon-server.exe` on
   Windows), and the `climon-alpha` sentinel marker.
4. Unzip the archive into a scratch directory and run `install` (or
   `install.exe`) targeting the scratch install directory.
5. List the installed files in the scratch install directory.

**Expected result:**
- The zip contains no `climon-beta` entry — only `install`, `climon-server`,
  and `climon-alpha`.
- After install, the install directory contains `climon` and `climon-server`
  and no `climon-beta` file.
- `climon server` starts the dashboard normally using the standalone
  `climon-server` binary.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-RB-02 — Update removes an orphaned `climon-beta`

- **ID:** MT-RB-02
- **Feature / phase:** Remove `climon-beta` from the distribution
- **Preconditions:** A scratch install directory containing a previous-style
  install (`climon`, `climon-server`, and a leftover `climon-beta` file).
  Use a scratch `$CLIMON_HOME` and scratch install directory under the project
  workspace.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. In the scratch install directory, place `climon`, `climon-server`, and a
   dummy `climon-beta` file to simulate an older install.
2. Run `climon update` (or the self-update path) so it swaps in the new
   binaries from a release/staging directory.
3. List the install directory contents after the update completes.

**Expected result:**
- The update succeeds and `climon`/`climon-server` are updated in place.
- The orphaned `climon-beta` file is deleted from the install directory.
- A failed/aborted update does not delete `climon-beta` prematurely (cleanup
  only runs on a clean successful swap).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-RB-03 — Client `server` subcommand still works without any JS bundle

- **ID:** MT-RB-03
- **Feature / phase:** Remove `climon-beta` from the distribution
- **Preconditions:** A fresh install from MT-RB-01 with no `climon-beta`
  present. Use a scratch `$CLIMON_HOME`.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. From the install directory (with no `climon-beta` present), run
   `climon server`.
2. Open the printed dashboard URL in a browser and confirm it loads.
3. Start a session and confirm it appears in the dashboard.

**Expected result:**
- The dashboard server starts by spawning the sibling `climon-server` binary
  (resolved via `resolveServerInvocation`), with no attempt to load an
  in-process JS bundle.
- The dashboard loads and live sessions appear as expected.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
