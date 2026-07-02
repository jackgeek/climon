# Phase 11 — `climon-install` (install / setup / onboarding)

These cases prove that the ported `climon-install` crate reproduces the
TypeScript client-side install and onboarding behavior: the install manifest
and on-disk layout match the Bun installer (so the non-destructive updater keeps
swapping the same files), the install directory is added to the user's `PATH`
on macOS/Linux/Windows, `climon setup` re-runs onboarding, telemetry/auto-update
opt-ins persist to config, and the install id is stable across runs.

Background: Phase 11 ports `src/install/*` (`install-manifest.ts`, `files.ts`,
`files-unix.ts`, `path.ts`, `processes.ts`, `windows.ts`, `changelog.ts`, and
the macOS/Linux/Windows shell-profile helpers), `src/setup/*`
(`setup-cmd.ts`, `onboarding.ts`, `install-id.ts`), and the pure
`src/release/version-bump.ts` helper into the new `climon-install` library
crate. The deferred Phase-8 `climon setup` stub in `climon-cli` is wired to
`climon_install::run_setup_command`. OS-specific code is gated with
`cfg(target_os = …)`; pure helpers take injected platform/env params so all three
platforms are unit-tested on any host. The Bun release/compile pipeline in
`scripts/` is **unchanged** — only the client-side install/setup logic was
ported. See the
[master plan](../superpowers/specs/2026-06-17-rust-client-rewrite-master-plan.md)
and the [Phase 11 plan](../superpowers/plans/2026-06-18-phase11-climon-install.md).

The install-manifest/on-disk-layout parity with the Bun installer is the **top
priority**: the cross-language fixture (`fixtures/install/manifest.json`,
`tests/install-fixtures.test.ts`, `rust/climon-install/tests/install_fixtures.rs`)
pins it from both sides.

This phase spans the **OS** dimension (file placement + permissions, PATH edit
mechanism, running-process detection):

| Cell | OS | Install dir PATH edit | Process detection | File perms |
|---|---|---|---|---|
| INST-linux | Linux (x64) | shell rc (`.bashrc` / fish `conf.d`) | `pgrep`/proc scan | `chmod 0755` on binaries |
| INST-macos | macOS (arm64) | shell profile (`.zshrc` / `.bash_profile`) | `ps` scan | `chmod 0755` on binaries |
| INST-win | Windows (x64) | user `PATH` registry (HKCU `Environment`) | PowerShell `Get-CimInstance` | n/a (NTFS) |

Run the cases on each listed platform. Steps that differ per cell call it out.
All cases isolate state with a temp `CLIMON_HOME` so they never touch a real
`~/.climon`.

---

## MT-P11-01 — `climon-install` builds, tests, and lints on all 3 OSes

- **ID:** MT-P11-01
- **Feature / phase:** Phase 11 — `climon-install` crate
- **Preconditions:** Repo checked out; stable Rust toolchain with `rustfmt` +
  `clippy`; `cargo-deny` + `cargo-about` installed; Bun installed for the
  cross-language fixture test.
- **Config-matrix cell:** all
- **Platforms:** macOS (arm64), Linux (x64), Windows (x64)

**Steps:**
1. From the repo root: `cd rust`.
2. Build: `cargo build -p climon-install`.
3. Test: `cargo test -p climon-install` (ported unit tests + `config_settings_installer` + `install_fixtures`).
4. Lint gates: `cargo fmt --all --check` and
   `cargo clippy --workspace --all-targets -- -D warnings`.
5. License gate: `cargo deny check`; confirm `THIRD-PARTY-LICENSES.md` is
   regenerated and idempotent (`cargo about generate about.hbs`).
6. Cross-language fixtures (from repo root): `bun test tests/install-fixtures.test.ts`.

**Expected:** All build/test/lint/deny steps pass; the Bun fixture test confirms
the per-platform install manifest matches `fixtures/install/manifest.json`
exactly (same source/dest file names). No new third-party deps (only the
first-party `climon-install` entry is added to `THIRD-PARTY-LICENSES.md`).

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P11-02 — fresh install places files matching the manifest

- **ID:** MT-P11-02
- **Preconditions:** Extracted release artifact (or a stand-in dir containing
  `install[.exe]`, `climon-server[.exe]`, `climon-beta`); an empty install dir.
- **Config-matrix cell:** INST-linux / INST-macos / INST-win
- **Platforms:** all

**Steps:**
1. Inspect the manifest for your platform: it lists, in order,
   `install[.exe] → climon[.exe]`, `climon-server[.exe] → climon-server[.exe]`,
   `climon-beta → climon-beta`.
2. Run the install (placement) flow into the empty install dir.
3. Confirm each manifest entry's `dest` now exists in the install dir.
4. (Unix) confirm `climon` and `climon-server` are mode `0755` (executable).
5. Confirm a version marker file is written for the installed version.

**Expected:** Exactly the manifest files are placed (the `install` source is
renamed to `climon` on disk; `.exe` suffixes only on Windows), with executable
bits on Unix binaries. The set/order matches the Bun installer so the updater
swaps the identical files.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P11-03 — install adds the install dir to the user's PATH

- **ID:** MT-P11-03
- **Preconditions:** temp `CLIMON_HOME`; a throwaway user profile/rc file (Unix)
  or a snapshot of the HKCU `Environment` `Path` value (Windows).
- **Config-matrix cell:** INST-linux / INST-macos / INST-win
- **Platforms:** all

**Steps:**
1. **macOS/Linux:** point the PATH editor at a temp shell profile/rc that does
   not yet contain the install dir. Run the PATH-ensure step.
2. Confirm an export line placing the install dir **first** on `PATH` was added
   to the profile (zsh → `.zshrc`, bash → `.bash_profile` on macOS / `.bashrc`
   on Linux; fish → a `conf.d` snippet, creating the parent dir).
3. Re-run the PATH-ensure step → confirm it is **idempotent** (no duplicate
   line; the entry stays first).
4. **Windows:** read the current user `Path`, run the user-PATH update, and
   confirm the install dir is prepended in the HKCU `Environment` `Path` (a
   `WM_SETTINGCHANGE` broadcast is emitted). Re-run → idempotent.

**Expected:** The install dir becomes the first `PATH` entry via the correct
per-OS mechanism; re-running does not duplicate it. Unix edits the right rc/
profile for the detected shell; Windows edits the user (not machine) PATH.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P11-04 — `climon setup` re-runs onboarding

- **ID:** MT-P11-04
- **Preconditions:** temp `CLIMON_HOME` (PowerShell: set `$env:CLIMON_HOME`).
- **Config-matrix cell:** all
- **Platforms:** all

**Steps:**
1. `climon setup` → answer the telemetry opt-in and auto-update opt-in prompts.
2. Inspect `$CLIMON_HOME/config.jsonc` → confirm `telemetry.enabled` and
   `update.*` reflect your answers.
3. `climon setup` again → confirm onboarding re-runs (prompts appear again) and
   updates the persisted values.
4. `climon setup --help` → confirm the option surface matches the TS `setup`
   command.

**Expected:** `climon setup` re-runs the full onboarding flow each time and
persists telemetry and auto-update choices to the global config under
`CLIMON_HOME`. Arg parsing matches the TS `setup` command.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P11-06 — telemetry / auto-update opt-in persisted

- **ID:** MT-P11-06
- **Preconditions:** temp `CLIMON_HOME`.
- **Config-matrix cell:** all
- **Platforms:** all

**Steps:**
1. Run onboarding and **enable** telemetry and auto-update.
2. Confirm `telemetry.enabled=true` and the auto-update opt-in are written to the
   global config.
3. Run onboarding again and **decline** both.
4. Confirm the config now reflects the declined (false/off) values.

**Expected:** Both opt-ins default off, are written verbatim to the global
config, and round-trip across runs (booleans coerced consistently with the TS
client).

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P11-07 — install id is stable

- **ID:** MT-P11-07
- **Preconditions:** temp `CLIMON_HOME`.
- **Config-matrix cell:** all
- **Platforms:** all

**Steps:**
1. Ensure an install id exists (run onboarding or the ensure-install-id step).
2. Read `install.id` from the config → note its value (a UUIDv4).
3. Run the ensure-install-id step again.
4. Read `install.id` again → confirm it is **unchanged**.
5. Delete `CLIMON_HOME` and repeat → confirm a **new** id is generated for the
   fresh home.

**Expected:** The install id is generated once per `CLIMON_HOME`, persisted as an
internal config value, and remains stable across subsequent runs; a fresh home
yields a new id.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P11-08 — running-process detection before swap

- **ID:** MT-P11-08
- **Preconditions:** Ability to start/stop a dummy `climon`/`climon-server`
  process.
- **Config-matrix cell:** INST-linux / INST-macos / INST-win
- **Platforms:** all

**Steps:**
1. With no running climon processes, run the process-detection step → confirm it
   reports none.
2. Start a long-running `climon`/`climon-server` (or a stand-in named process).
3. Run the detection/kill step → confirm running climon processes are detected
   (Windows: via the PowerShell `Get-CimInstance` script) so a locked-binary
   swap can retry after terminating them.
4. Confirm a locked-binary copy error (`EBUSY`/`EACCES`/`EPERM`, plus `ETXTBSY`
   on Unix) is classified as retryable.

**Expected:** Running climon processes are detected per-OS and locked-file copy
errors are recognized so the installer/updater can terminate them and retry the
swap, matching the TS behavior.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P11-09 — macOS install strips the `com.apple.quarantine` Gatekeeper flag

- **ID:** MT-P11-09
- **Feature / phase:** Phase 11 — `climon-install` crate (macOS Gatekeeper fix)
- **Preconditions:** A real Mac (Apple Silicon or Intel). A release `.zip`
  downloaded **through a browser** (Safari/Chrome) so macOS applies the
  `com.apple.quarantine` attribute, or a stand-in dir whose `install`,
  `climon-server`, and `climon-beta` files have been quarantined manually with
  `xattr -w com.apple.quarantine "0081;0;manual;" <file>`.
- **Config-matrix cell:** INST-macos
- **Platforms:** macOS (arm64 / x64)

**Background:** Without this, the binaries inherit quarantine through the install
copy and Gatekeeper refuses to launch the unsigned `climon-server` with
*"climon-server is damaged and can't be opened. You should move it to the
Trash."*

**Steps:**
1. Confirm the **source** binaries are quarantined:
   `xattr -p com.apple.quarantine <source>/climon-server` prints a value (does
   not error).
2. Run the install (placement) flow into an empty install dir (default
   `~/.local/bin`).
3. For each installed binary, check the attribute is gone:
   `xattr -p com.apple.quarantine ~/.local/bin/climon` → prints
   `No such xattr` (and likewise for `climon-server` and `climon-beta`).
4. Run `climon server` → it starts (Gatekeeper does **not** report it as
   "damaged").

**Expected:** After install, none of `climon`, `climon-server`, or `climon-beta`
carry `com.apple.quarantine`, and `climon server` launches normally. (No-op on
Linux/Windows.)

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |
