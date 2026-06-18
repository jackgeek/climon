# Phase 12 — Cutover & cleanup (ship the Rust client + native self-install)

These cases prove that the **Rust** `climon` client is the shipped client and
that the self-install flow is now native Rust — no JavaScript installer bundle.
They cover: building and packaging the host platform's release zip with the Rust
client as the `install` binary; the native self-install on each OS (PATH edit,
`.version` write, changelog tail); upgrading over a previous version;
the licence-declined abort path; the locked-binary kill/retry path; and the
release-pipeline cross-compile matrix (one cell per target).

Background: Phase 12 makes `scripts/compile.ts` ship the Rust `climon` client
(built with `cargo build --release -p climon-cli`) as the `install` binary inside
each `dist/climon-<platform>.zip`, alongside the **unchanged** Bun `climon-server`
and `climon-beta` bundles. The former JavaScript installer bundle (`climon-alpha`)
is replaced by a tiny **sentinel marker** file of the same name: when the shipped
client runs and finds `climon-alpha` next to its executable, it runs the native
Rust self-installer (`climon_install::run_installer`) instead of normal dispatch.
The self-install composes the existing `climon-install` building blocks
(`install-manifest`, file placement, PATH setup, version-file write, changelog)
ported in Phase 11 — see `rust/climon-install/src/installer.rs` and the
`try_run_installer` wiring in `rust/climon-cli/src/main.rs`. The Bun client
(`src/index.ts`, `src/install/*`) is retained for the Bun test suite and local
development but is no longer the published `climon` bin. See the
[master plan](../superpowers/specs/2026-06-17-rust-client-rewrite-master-plan.md)
and the [Phase 12 plan](../superpowers/plans/2026-06-18-phase12-cutover.md).

This phase spans the **OS** dimension (Rust cross-compile target, PATH edit
mechanism, locked-file/process handling):

| Cell | OS | Rust target | Native runner | Install dir PATH edit |
|---|---|---|---|---|
| CUT-linux-x64 | Linux (x64) | `x86_64-unknown-linux-gnu` | `ubuntu-latest` | shell profile (`.bashrc` / fish `conf.d`) |
| CUT-linux-arm64 | Linux (arm64) | `aarch64-unknown-linux-gnu` | `ubuntu-latest` + `cargo-zigbuild` (cross) | shell profile |
| CUT-macos-arm64 | macOS (arm64) | `aarch64-apple-darwin` | `macos-latest` | shell profile (`.zshrc` / `.bash_profile`) |
| CUT-macos-x64 | macOS (Intel) | `x86_64-apple-darwin` | `macos-latest` | shell profile |
| CUT-win-x64 | Windows (x64) | `x86_64-pc-windows-msvc` | `windows-latest` | user `PATH` registry (HKCU `Environment`) |

Run the cases on each listed platform. Steps that differ per cell call it out.
All cases isolate state with a throwaway `HOME`/`CLIMON_HOME` and a temp install
dir so they never touch a real `~/.climon` or a real shell profile.

---

## MT-P12-01 — package the host platform's release zip with the Rust client

- **ID:** MT-P12-01
- **Feature / phase:** Phase 12 — `scripts/compile.ts` ships the Rust client
- **Preconditions:** Repo checked out; Bun installed; stable Rust toolchain;
  `bun install --frozen-lockfile` run once.
- **Config-matrix cell:** host cell (the OS you run on)
- **Platforms:** macOS (arm64), Linux (x64), Windows (x64)

**Steps:**
1. From the repo root: `bun scripts/compile.ts` (local/default mode — no
   `CLIMON_ASSEMBLE`).
2. Confirm it built the host Rust client (`cargo build --release -p climon-cli`)
   and emitted only `dist/climon-<host>.zip` (e.g. `climon-darwin-arm64.zip`).
3. Unzip the archive and list its entries.
4. Inspect the `install` entry's file type (`file install` on Unix).

**Expected:** The zip contains exactly four entries: `install` (or `install.exe`
on Windows), `climon-server` (or `.exe`), `climon-beta`, and `climon-alpha`. The
`install` entry is a native executable for the host (Mach-O / ELF / PE), **not** a
Bun/JS bundle. `climon-alpha` is a tiny text sentinel marker (not a JS file). On
Unix the `install`, `climon-server`, and `climon-beta` entries have mode `0755`.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P12-02 — native self-install on a fresh machine (PATH + `.version` + changelog)

- **ID:** MT-P12-02
- **Feature / phase:** Phase 12 — native Rust self-installer
- **Preconditions:** A host release zip from MT-P12-01; a throwaway `HOME` and
  temp install dir; no prior climon install in the temp PATH.
- **Config-matrix cell:** CUT-<host>
- **Platforms:** macOS (arm64), Linux (x64), Windows (x64)

**Steps:**
1. Extract the host zip into a temp `stage/` dir (so `install`, `climon-server`,
   `climon-beta`, `climon-alpha` are siblings).
2. Point environment at throwaway state: set `HOME` (Unix) / `USERPROFILE` +
   `LOCALAPPDATA` (Windows) and `CLIMON_HOME` to temp dirs. Pre-create an empty
   shell profile (Unix) so the PATH edit has a target.
3. Run the self-installer non-interactively from `stage/`:
   `./install --apply --accept-eula` (`install.exe` on Windows). The presence of
   the `climon-alpha` sentinel beside `install` triggers `run_installer`.
4. Inspect the install dir (`~/.local/bin` on Unix /
   `%LOCALAPPDATA%\Programs\climon` on Windows).
5. Inspect the shell profile (Unix) / user `PATH` (Windows).
6. Inspect `<install-dir>/.version` and the console output.

**Expected:** The installer copies `install`→`climon`, `climon-server`→
`climon-server`, `climon-beta`→`climon-beta` into the install dir (names per
`installFilesForPlatform`; `.exe` on Windows). On Unix `climon` and `climon-beta`
are `chmod 0755` (matching the TS installer, which does not chmod
`climon-server`). `<install-dir>/.version` contains the release version. The shell
profile gains a line adding the install dir to `PATH` (Unix) or the user `PATH`
registry value gains the install dir (Windows); the console prints the
"added to PATH" message and a "restart your shell" hint. The changelog tail for
the version is printed. Exit code is 0.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P12-03 — upgrade over a previous installed version

- **ID:** MT-P12-03
- **Feature / phase:** Phase 12 — native self-installer (re-install path)
- **Preconditions:** MT-P12-02 already run against a temp install dir (so a prior
  `climon`/`.version` exists); a second host zip (same or newer version).
- **Config-matrix cell:** CUT-<host>
- **Platforms:** macOS (arm64), Linux (x64), Windows (x64)

**Steps:**
1. With the install dir from MT-P12-02 already populated, note the existing
   `.version` and the shell profile contents.
2. Extract the second zip and run `./install --apply --accept-eula` again against
   the **same** throwaway `HOME`/install dir.
3. Re-inspect the install dir, `.version`, and shell profile.

**Expected:** Binaries are replaced in place (no duplicate copies); `.version` is
updated to the new version. The PATH edit is **idempotent** — the profile does not
gain a second PATH line (console prints the "already on PATH" message instead of
"added"). The previous-version read is reported (the installer detects the prior
install). Exit code 0; no running sessions are required to be killed for a normal
upgrade.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P12-04 — licence-declined abort

- **ID:** MT-P12-04
- **Feature / phase:** Phase 12 — EULA gate in the native self-installer
- **Preconditions:** A host release zip; a throwaway `HOME`/`CLIMON_HOME` with no
  previously accepted EULA; empty install dir.
- **Config-matrix cell:** CUT-<host>
- **Platforms:** macOS (arm64), Linux (x64), Windows (x64)

**Steps:**
1. Extract the zip into `stage/` with the `climon-alpha` sentinel present.
2. Run the installer in a way that declines the licence: either run interactively
   and answer "no" at the EULA prompt, or run `./install --apply` **without**
   `--accept-eula` (apply requires acceptance to proceed).
3. Observe the console output and exit code.
4. Inspect the install dir and config.

**Expected:** The installer prints the licence-declined / "must accept" message,
pauses for exit (no-op when not a TTY), and exits with a **non-zero** status (1).
No binaries are copied into the install dir, no `.version` is written, and the
shell profile / user PATH is left unchanged. `eula.accepted` is not set to true.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P12-05 — locked-binary kill/retry

- **ID:** MT-P12-05
- **Feature / phase:** Phase 12 — `installBinaries` confirm-kill-and-retry
- **Preconditions:** A host release zip; a temp install dir; ability to hold a
  target binary open/running (a long-lived `climon`/`climon-server` process or, on
  Windows, an open handle to the file).
- **Config-matrix cell:** CUT-<host>
- **Platforms:** macOS (arm64), Linux (x64), Windows (x64)

**Steps:**
1. Install once (MT-P12-02) so `climon-server` exists in the install dir.
2. Start a long-running process holding the installed `climon-server` (e.g.
   `climon server` from the install dir), so the file is busy/locked.
3. Run `./install --apply --accept-eula` again to upgrade.
4. When prompted that a climon process is holding a target file, confirm the
   kill-and-retry.
5. Re-inspect the install dir.

**Expected:** On a locked/busy target the installer detects the running climon
process, prompts to kill it (confirm-kill-and-retry), and on confirmation
terminates the process and retries the copy successfully. The upgraded binaries
are in place and `.version` is updated. If the user declines the kill, the
installer reports it could not replace the locked file and exits non-zero without
partially corrupting the install dir. (Unit coverage:
`installer.rs` locked-binary retry test.)

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P12-06 — `tryRunInstaller` dispatch (sentinel present vs absent)

- **ID:** MT-P12-06
- **Feature / phase:** Phase 12 — `try_run_installer` in `climon-cli`
- **Preconditions:** A built Rust `climon` binary.
- **Config-matrix cell:** CUT-<host>
- **Platforms:** macOS (arm64), Linux (x64), Windows (x64)

**Steps:**
1. Copy the Rust `climon` binary to a temp dir as `install` with a `climon-alpha`
   sentinel sibling; run `./install ls`. Confirm it takes the **install** path
   (runs the self-installer), not the `ls` command.
2. Remove the `climon-alpha` sibling; run `./install ls` (or `climon ls`) again.
   Confirm it dispatches normally to the `ls` command.

**Expected:** With the sentinel present the binary self-installs (install path is
taken before arg parsing, matching `src/index.ts` main() order). Without the
sentinel it parses args and runs the requested subcommand normally. (Unit
coverage: `rust/climon-cli/src/installer.rs` marker-present/absent tests.)

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P12-07 — release-pipeline cross-compile matrix (per-OS cell)

- **ID:** MT-P12-07
- **Feature / phase:** Phase 12 — `.github/workflows/release.yml` Rust matrix
- **Preconditions:** CI only (cannot be validated locally for non-host targets).
  A `chore(release):`-free push to `main`, or a manual `workflow_dispatch`.
- **Config-matrix cell:** one row per target (CUT-linux-x64, CUT-linux-arm64,
  CUT-macos-arm64, CUT-macos-x64, CUT-win-x64)
- **Platforms:** all five release targets

**Steps:**
1. Trigger the release workflow. Confirm the `version` job computes the bump and
   the `chore(release):` skip guard short-circuits release commits.
2. Confirm the `build-client` matrix builds the Rust client for each target on
   the listed native runner, pinning the bumped version via `CLIMON_VERSION`, and
   uploads each `install`/`install.exe` as an artifact. For `aarch64-unknown-linux-gnu`
   confirm the `cargo-zigbuild` (cross) install + build step runs on ubuntu.
3. Confirm the `release` (assemble+publish) job downloads all client artifacts
   into `dist/.rust-clients/<platform>/`, installs Bun, runs
   `bun install --frozen-lockfile`, and runs `bun run compile` in **assemble**
   mode (`CLIMON_ASSEMBLE=1`).
4. Confirm the five `dist/climon-<platform>.zip` archives are produced, each with
   the Rust `install` binary, the Bun `climon-server`/`climon-beta` bundles, and
   the `climon-alpha` sentinel.
5. Confirm the existing sign/encrypt/verify/publish steps run unchanged: the
   `HAS_SIGNING_KEY`/`HAS_DISTRIBUTION_KEY` gates, `manifest.json`, `.sig`/`.enc`
   verification, GitHub release publish to both repos, and the bump-commit/tag
   push.

**Expected:** Each matrix cell produces a per-target `install` artifact on its
native runner; the assemble job packages all five zips from the prebuilt clients
and runs the unchanged signing/verification/publish flow. A version bump commit
and `vX.Y.Z` tag are pushed; `chore(release):` commits do not re-trigger a
release.

| Date | Tester | Target / runner | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P12-08 — DoD gates (fmt / clippy / test / deny / about / typecheck / bun test)

- **ID:** MT-P12-08
- **Feature / phase:** Phase 12 — definition of done
- **Preconditions:** Repo checked out; Rust toolchain with `rustfmt` + `clippy`;
  `cargo-deny` + `cargo-about` installed; Bun installed.
- **Config-matrix cell:** all
- **Platforms:** macOS (arm64), Linux (x64), Windows (x64)

**Steps:**
1. From `rust/`: `cargo fmt --all --check`.
2. From `rust/`: `cargo clippy --workspace --all-targets -- -D warnings`.
3. From `rust/`: `cargo test --workspace`.
4. From `rust/`: `cargo deny check`.
5. From `rust/`: `cargo about generate about.hbs > /tmp/x.md` then
   `diff -q THIRD-PARTY-LICENSES.md /tmp/x.md`.
6. From the repo root: `bun run typecheck`.
7. From the repo root: `bun test tests`.

**Expected:** Steps 1–5 are clean (fmt clean, no clippy warnings, 0 test
failures, deny ok, `THIRD-PARTY-LICENSES.md` identical to the regenerated file —
no new third-party deps were added). `bun run typecheck` is clean modulo the
pre-existing `tests/config-docs.test.ts` generated-doc drift. `bun test tests` has
no **new** failures versus the recorded baseline (the install/setup/compile/
remote/update suites stay green).

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |
