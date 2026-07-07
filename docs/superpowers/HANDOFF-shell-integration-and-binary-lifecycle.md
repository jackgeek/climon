# Handoff: Windows Binary Lifecycle (shipped) → Upgrade Test → Shell Integration

Date: 2026-07-06 (updated after Feature 2 implementation + upgrade-test brainstorm)
Author of handoff: working session (context-compacted)

> **Read this first.** Single entry point for the remaining climon work. Everything
> referenced lives in the **gitignored** `docs/superpowers/` directory (written,
> never committed). Feature 2 (binary lifecycle) is now **implemented and open as
> PR #97**; the remaining work is (A) an end-to-end **upgrade test harness** before
> #97 ships, (B) the **bridge-release rollout** sequencing, and (C) **Feature 1
> shell integration** (spec done, plan not written, then execute).

---

## Outstanding items (do in this order)

| # | Item | State | Skill to use |
|---|------|-------|--------------|
| A | **End-to-end upgrade test harness** for Feature 2 | **Design approved (below). Spec + plan NOT yet written.** | writing-plans → subagent-driven-development |
| B | **Bridge-release rollout** of Feature 2 (tag bridge w/ legacy packaging, then "C") | Blocked on A passing + PR #97 merged to `dev` | (release runbook) |
| C | **Feature 1 shell integration** | Spec approved; **plan NOT written**; then execute | writing-plans → subagent-driven-development |

PR #97: <https://github.com/jackgeek/climon/pull/97> — OPEN against `dev`, title
"Windows-safe binary lifecycle: stub + versioned DLL + dedicated installer".
**Do not merge to `dev`/`main` and do not cut "C" until the bridge ordering (item B)
is handled** — shipping the stub model ("C") before the bridge rolls out bricks
legacy installs.

---

## Feature 2 — Windows-safe binary lifecycle (IMPLEMENTED, PR #97 open)

### What it does
Ships a stable zero-dependency `climon.exe` **stub** that resolves a plain-text
`climon.version` pointer and `LoadLibraryW`s `climon-<ver>.dll` in-process (calling
exported `climon_main`), plus a `climon-server.exe` stub launching
`climon-server-<ver>.exe` as a child. This lets Windows self-update while many
terminals are running (the stub is never locked). Replaces the legacy
`install.exe`→`climon.exe` rename + `climon-alpha` sentinel with a dedicated
cross-platform installer (`climon-setup` → `install[.exe]`). Unix keeps
rename-over-swap. A Windows-only reaper deletes superseded, unlocked, strictly
older versioned files.

### Crates / files (all complete on branch `windows-binary-lifecycle`)
- `rust/climon-stub/` — stub loader (client DLL loader + server exe launcher, pointer
  resolution + highest-semver fallback). Zero deps (cross-checks clean on macOS).
- `rust/climon-dll/` — cdylib `climon.dll` exporting frozen `climon_main` C ABI,
  dispatches into `climon_cli::run`. `climon-cli` still builds a **full standalone
  `climon` bin** too (shares `climon_cli::run`) — important for the test harness.
- `rust/climon-setup/` — dedicated installer; stubs embedded via `build.rs` reading
  `CLIMON_CLIENT_STUB`/`CLIMON_SERVER_STUB` (panics if absent on Windows builds).
- `rust/climon-update/src/update_cmd.rs` — Windows additive versioned-write + pointer
  flip; `should_migrate_legacy`; `migrate_via_bundled_installer`.
- `rust/climon-update/src/reaper.rs` — reaps only versions **strictly older** than the
  pointer target (helpers `parse_semver`/`cmp_semver`/`version_between`).
- `rust/climon-update/src/check.rs` — `DEFAULT_MANIFEST_URL` (hardcoded GitHub URL,
  **no override today**), `run_background_check`.
- `rust/climon-update/src/pubkey.rs` — `UPDATE_PUBLIC_KEY_B64 = env!("CLIMON_UPDATE_PUBKEY_B64")`
  injected at **build time** by `build.rs` from `src/update/pubkey.ts`.
- `rust/climon-install/src/{files.rs,installer.rs}` — `place_windows_layout*`
  (pointers written **LAST** so a mid-migration crash is recoverable), `run_migrate`,
  `parse_migrate_args`.
- `scripts/compile.ts` + `.github/workflows/release.yml` — 3-artifact zip
  (`install[.exe]`, client `climon`/`climon.dll`, `climon-server[.exe]`); stubs
  embedded inside the installer, not separate zip entries; `climon-alpha` dropped.
- `docs/manual-tests/windows-binary-lifecycle.md` — 10 MT-WBL cases.
- Docs: `docs/architecture.md` (§"Binary lifecycle and release layout", §"Migrating
  existing Windows installs (bridge release)"), `docs/features.md`
  (`cli-windows-binary-lifecycle`), `CHANGELOG.json` (3.2.0 entry).

### Verification state (as of PR #97)
`cargo build/test/clippy --all-targets/fmt --check` all clean on macOS host. Host
`bun scripts/compile.ts` produces a correct 3-file zip. Pre-existing (NOT
regressions): 3 `bun run typecheck` errors (@types/node) + 1 flaky web test.
**Cannot verify on macOS:** any `#[cfg(windows)]` runtime path — the host can't
cross-compile crates that pull in `ring`. CI Windows runners + the upgrade harness
(item A) + manual tests cover these.

### Bridge / migration model (self-describing, no manifest schema change)
- Legacy install = single `climon.exe`, **no** `climon.version` pointer.
- `should_migrate_legacy(install_dir, unzipped)` → true iff install has no pointer
  AND the release zip is **stub-model** (contains `climon.dll` + `install.exe`).
- When true, updater runs `install.exe --migrate --dir <install_dir> --source <staging>`
  (idempotent). Unix `--migrate` = success no-op.
- **Rollout order (item B):** (1) **Bridge** release cut from a state that STILL
  packages the legacy layout but has the migration-aware updater — old installs
  auto-update to it as before. (2) **"C"** = first stub release, cut AFTER the Phase 5
  packaging flip. Bridge→C auto-migrates. An install that skips the bridge and jumps
  to C bricks and must re-run `install.ps1` (accepted, mitigated by publishing C only
  after bridge adoption).

---

## Item A — End-to-end upgrade test harness (DESIGN APPROVED — write spec+plan next)

**Goal:** exercise the risky, never-before-run Windows migration paths for Feature 2
before PR #97 / the bridge release ships. Runs on a **real Windows machine/VM**
(migration is `#[cfg(windows)]`-only; macOS/Linux only do rename-swap).

**Chosen strategy — "Hybrid C":** fast local iteration with a *throwaway* signing key,
then one CI-signed GitHub **pre-release** dry-run for real-key/packaging fidelity.
Hard constraint from the user: **the production signing private key must never leave
GitHub Actions.** Design honours this — locally we only ever use a disposable test key.

### 1. Dev-only override (minimal, provably inert)
- Add cargo feature `test-update-endpoint` to `climon-update` (pass-through from
  `climon-cli`). **Never** enabled by `compile.ts` / `release.yml`.
- Under that feature only, the update flow (`update_cli.rs`) reads a runtime env var
  `CLIMON_TEST_MANIFEST_URL` and uses it instead of `DEFAULT_MANIFEST_URL`. Compiled
  out otherwise — shipped binaries physically lack the code (auditable; matches
  climon's loopback-only / hardcoded-trust security posture).
- **Test key needs NO new code:** build the test binaries with
  `CLIMON_UPDATE_PUBKEY_B64=<test-pubkey>` (existing `build.rs` path) and sign local
  zips with the matching throwaway private key. Production key untouched.

### 2. Harness components (one bun script, e.g. `scripts/upgrade-test-harness.ts`)
- **Test keypair:** generate ephemeral Ed25519 (as in `scripts/gen-update-fixtures.ts`);
  print the pubkey to build with; keep the privkey in memory to sign.
- **Bridge zip** (`climon-windows-x64.zip`, legacy layout): build `climon-cli` bin
  (full standalone client — already has the migration-aware updater via `climon_cli::run`)
  + `climon-server`, package as `climon.exe` + `climon-server.exe`, **no** DLL/installer.
  The absence of `climon.dll`+`install.exe` is exactly what marks it non-stub-model.
  Needs a test-only legacy-layout packaging path (new `--legacy-layout` flag in
  `compile.ts`, or inline in the harness).
- **C zip:** current `compile.ts` stub-layout output (`install.exe` + `climon.dll`
  + `climon-server.exe`).
- **Sign + serve:** reuse `signReleaseDir()` from `scripts/sign-release.ts` with
  `baseUrl=http://<host>:<port>` (it signs every `climon-*.zip` and emits
  `manifest.json`), then serve that dir (manifest + zips + `.sig`) over a local static
  server.

### 3. Test procedure (on the Windows box)
Build client with `--features test-update-endpoint` + `CLIMON_UPDATE_PUBKEY_B64=<test pub>`,
point it at the harness via `CLIMON_TEST_MANIFEST_URL`, and walk:
1. **bridge → C migration:** unzip bridge into a scratch install (no `climon.version`),
   serve C manifest, `climon update` → assert `install.exe --migrate` fired; stub
   layout present (`climon.exe` stub + `climon-<ver>.dll` + pointers); `climon --version`
   works.
2. **C → C+1 stub update:** bump version, re-sign, `climon update` → assert additive
   versioned write + pointer flip; reaper drops the strictly-older payload; no migration.
3. **idempotent `--migrate`:** run `install.exe --migrate` twice → 2nd is a clean no-op.
4. **brick + recovery (reframed):** instead of building a real pre-branch "old" binary,
   materialize a broken install dir (legacy `climon.exe` + C's stray files, no working
   stub), run `install.ps1`/`install.exe` → assert it recovers to a clean working stub
   layout. Tests the user-facing recovery guarantee directly.

These map onto / update the existing `docs/manual-tests/windows-binary-lifecycle.md`
MT-WBL cases.

### 4. Final fidelity check (Hybrid phase B)
One CI-signed GitHub **pre-release** of a C build (real `release.yml`) + a manual
`climon update` against it on Windows → confirms the real embedded key verifies real
CI-signed artifacts + real packaging. No test code involved; nothing published to
production `latest`.

### Open decision deferred to spec review
The user was asked to approve the design (incl. reframed brick test 3.4) and instead
asked for this handoff. **Confirm the brick-test framing** (simulated broken install
vs building a real pre-branch "old" binary) when resuming.

---

## Feature 1 — Shell integration (SPEC DONE, PLAN NOT WRITTEN)

Spec: `specs/2026-07-06-shell-integration-design.md`. Depends on the `climon shell`
subcommand (`specs/2026-07-03-climon-shell-command-design.md` +
`plans/2026-07-03-climon-shell-command.md`) — **verify its current implementation
state before planning.** On Windows it benefits from Feature 2 being in place, so
Feature 2 ships first.

### Design summary
`climon shell-integration <status|install|uninstall>`. Interactive multi-select of
detected terminals; each points a "climon" profile at a generated **fallback shim**
(`$CLIMON_HOME/shell-integration/climon-shell.{sh,cmd,ps1}`) that runs `climon shell`
and, on any failure, `exec`s the user's real shell and warns — a terminal is never
left unusable. Every edit is backed up (manifest at
`$CLIMON_HOME/shell-integration/manifest.json`) and one-command reversible.

### Safety invariants
1. Never break a terminal (fallback shim, not `climon` directly). 2. Always reversible
(byte-for-byte restore). 3. Idempotent. 4. Opt-in. 5. Per-adapter isolation (one
failure never aborts `--all`).

### Architecture
New crate **`climon-shellint`** (sibling to `climon-install`) with a `TerminalAdapter`
trait (`id/display_name/detect/status/install/uninstall`) + per-OS registry. Adapter
ids: `apple-terminal`, `iterm2`, `windows-terminal`, `vscode`, `gnome-terminal`,
`konsole`, `wsl:<distro>`.

### Per-terminal mechanisms (v1)
- **macOS:** plist edits (`com.apple.Terminal`; iTerm2 profile GUID).
- **Windows Terminal:** JSONC edit of `settings.json` (packaged/unpackaged/portable).
- **GNOME Terminal:** `gsettings`/`dconf` profile UUID. **Konsole:** `.profile` +
  `konsolerc`. **VS Code:** JSONC `settings.json` per OS.
- **WSL:** guarded, idempotent rc-hook (`>>> climon shell-integration >>>` block) in the
  distro's `~/.bashrc`/`~/.zshrc`/`~/.profile`; four guards (interactive, tty,
  not-already-in-climon via `CLIMON_SESSION_ID`, `command -v climon`); needs Linux
  climon inside the distro. Reuses `is_wsl`/WSL bridge helpers from `climon-remote`.
  `--set-default` does not apply to WSL.

### Adds a feature flag
`shellIntegration` — must go in BOTH `rust/climon-config/src/features.rs` and
`src/features.ts`, then `bun scripts/gen-config-fixtures.ts`.

### Rejected approaches (do not revisit)
PATH/alias shims of `bash`/`pwsh`/`zsh` (breaks non-interactive scripts); true
login-shell replacement via `chsh`/registry (can lock users out).

---

## Recommended execution order

1. **Merge readiness first:** keep PR #97 open; do NOT cut "C" yet.
2. **Item A:** write spec (`docs/superpowers/specs/YYYY-MM-DD-windows-upgrade-test-design.md`)
   → plan → implement the harness; run the 4 test paths on a Windows box.
3. **Item B:** sequence the bridge release (tag bridge w/ legacy packaging from the
   right commit, then tag "C" with the flipped Phase-5 packaging) once A passes and #97
   is merged to `dev`.
4. **Item C:** write the shell-integration plan (after confirming `climon shell` state),
   then execute.

---

## Repo conventions / gotchas (must-know)

- **Client work goes in `rust/`.** Server is Bun under `src/` and is never rewritten.
  Build from `rust/`: `cargo build`, test `cargo test`, lint `cargo clippy --all-targets`,
  format `cargo fmt`.
- **Work in `.worktrees/<branch>`** off `dev`; **PRs target `dev`, never `main`** (pushing
  to `main` triggers the Release workflow / cuts a release).
- **`docs/superpowers/` is gitignored** — specs/plans/this handoff are written but NOT
  committed (and are per-worktree; this copy lives in `.worktrees/shell-integration`).
- **Feature-flag parity:** any flag goes in BOTH `rust/climon-config/src/features.rs` and
  `src/features.ts`, then `bun scripts/gen-config-fixtures.ts`.
- **Config settings** go in `src/config-settings.ts` + `bun run docs:config`.
- **Every feature needs `docs/manual-tests/<feature>.md`** linked from the README index;
  keep `docs/features.md` catalogue updated.
- VERSION comes from `env!("CLIMON_VERSION")` via build.rs (repo-root package.json; CI
  pins via `CLIMON_VERSION`). package.json stays at its current value on a feature branch;
  the version bump happens at release-cut.
- Two Bun server integration tests time out at ~30s locally — environmental, not
  regressions (see project memory).
- Use the **superpowers** skills for specs/plans (NOT the prd plugin) — user preference.

### Verification commands
```bash
# Rust (from rust/)
cd rust && cargo build --workspace && cargo test --workspace \
  && cargo clippy --all-targets && cargo fmt --check
# Bun (from repo root)
bun run typecheck && bun test tests
```

---

## Immediate next step

Resume **Item A**: confirm the brick-test framing (3.4), then run the `writing-plans`
skill to turn the approved harness design above into an implementation plan. Feature 1
follows after Feature 2 is fully shipped (bridge + C).
