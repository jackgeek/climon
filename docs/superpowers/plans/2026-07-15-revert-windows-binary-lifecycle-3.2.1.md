# Revert windows-binary-lifecycle for 3.2.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut a 3.2.1 patch release that fully reverts the windows-binary-lifecycle feature (PR #97) so updating from ≤3.1.x no longer overwrites `climon` with the installer stub, while preserving all reverted commits on a dedicated branch for later rework.

**Architecture:** The entire feature (dedicated `install[.exe]` installer, `climon.dll`/stub dual-build, versioned payloads + pointer-flip apply path, reaper, new zip layout) landed as a single squash-free merge (`5e3caf57`, PR #97). Nothing after it touched those paths, so a `git revert -m 1 5e3caf57` cleanly removes the feature. Two conflicts need manual resolution: the CLI entrypoint was refactored `main.rs` → `run.rs` by #97 and later touched by #123 (dev tunnels), so the restored v3.1.3 `main.rs` must be re-patched to call the current 2-arg `climon-remote` ingest API; plus doc/changelog text conflicts. The Release workflow auto-bumps the patch version and tags on merge to `main` (v3.2.0 is already tagged), so no manual version bump is needed — only a CHANGELOG entry.

**Tech Stack:** Rust workspace (`rust/`), Bun/TypeScript packaging (`scripts/compile.ts`), git worktrees, `gh` CLI.

---

## Root-cause recap (why this revert)

- Pre-3.2.0 updaters map zip entry `install` → dest `climon`. 3.2.0 repurposed `install` as a pure installer stub, so a ≤3.1.x client updating to 3.2.0 copies the installer over `climon` and breaks it (`rust/climon-update` install manifest + `scripts/compile.ts` zip layout).
- Fix: restore the v3.1.3 packaging/update behavior so the zip entry old updaters map onto `climon` is the real client binary again.

## Facts established (do not re-investigate)

- Feature merge: `5e3caf57` (PR #97 `windows-binary-lifecycle`). Feature-tip (pre-merge second parent): `git rev-parse 5e3caf57^2`.
- New crates introduced by the feature (all removed on revert): `rust/climon-dll`, `rust/climon-stub`, `rust/climon-setup`.
- New files removed on revert: `rust/climon-update/src/pointer.rs`, `rust/climon-update/src/reaper.rs`, `rust/climon-cli/src/run.rs`, `scripts/upgrade-harness/pack.ts`, `scripts/upgrade-test-harness.ts`, `tests/upgrade-harness.test.ts`, `docs/manual-tests/windows-binary-lifecycle.md`.
- File re-added on revert (existed at v3.1.3): `rust/climon-cli/src/installer.rs`.
- Only real code conflict: `rust/climon-cli/src/run.rs` (created by #97, modified by #123). At v3.1.3 the ingest entry lived inline in `main.rs` and called `climon_remote::ingest::spawn_devtunnel_host(id)` (1-arg). Current `climon-remote` signature is `spawn_devtunnel_host(&gateway, id)` (2-arg) — the restored `main.rs` must be re-patched to the 2-arg form to compile.
- Doc/text conflicts: `CHANGELOG.json`, `docs/features.md`.
- `rust/climon-cli/src/cleanup_cmd.rs` (later touched by #130) auto-merges — no action.
- Shared dependency bumps kept (NOT reverted, they are on dev's mainline independent of #97): workspace `getrandom = "0.4"` fill() API used by `climon-remote`/`climon-store`. The revert of #97 does downgrade `climon-update`'s `ed25519-dalek` back to `2` — that is expected v3.1.3 update behavior and is isolated to `climon-update`.
- Version bump: automatic on merge to `main` (Release workflow patch-bumps because v3.2.0 is tagged). Do NOT hand-edit `package.json`/CLI fixtures for 3.2.1.
- Worktree already created: `.worktrees/revert-installer-321`, branch `fix/revert-installer-321` off `origin/dev`.

---

## Task 1: Preserve the feature commits on a dedicated branch

**Files:** none (git refs only).

- [ ] **Step 1: Create and push the preservation branch at the feature tip**

```bash
cd /Users/jackallan/dev/climon
git branch feat/windows-binary-lifecycle 5e3caf57^2
git push -u origin feat/windows-binary-lifecycle
```

Expected: remote branch `feat/windows-binary-lifecycle` now points at the pre-merge feature tip, retaining every windows-binary-lifecycle commit for later rework.

- [ ] **Step 2: Verify the branch contains the feature commits**

```bash
git log --oneline -5 origin/feat/windows-binary-lifecycle
git log --oneline origin/feat/windows-binary-lifecycle | grep -iE "stub|setup|dll|pointer|reaper|versioned" | head
```

Expected: log shows the feat(stub)/feat(dll)/feat(setup)/feat(update) versioned-write commits.

---

## Task 2: Perform the merge-revert in the worktree

**Files:** many (git revert); conflicts resolved in Tasks 3–4.

- [ ] **Step 1: Start the revert**

```bash
cd /Users/jackallan/dev/climon/.worktrees/revert-installer-321
git status   # confirm clean, on fix/revert-installer-321
git revert --no-commit -m 1 5e3caf57
```

Expected: revert applies with conflicts in `CHANGELOG.json`, `docs/features.md`, and a modify/delete on `rust/climon-cli/src/run.rs`. Everything else auto-applies (crates deleted, `installer.rs` re-added, `compile.ts` restored).

- [ ] **Step 2: Resolve the run.rs modify/delete by removing it**

`run.rs` was introduced by #97; the revert deletes it. Keep it deleted:

```bash
git rm rust/climon-cli/src/run.rs
```

Expected: `run.rs` removed from the index.

---

## Task 3: Re-patch the restored CLI entrypoint to compile against current climon-remote

The revert restores v3.1.3 `rust/climon-cli/src/main.rs`, whose `run_ingest_entry()` calls the old 1-arg `spawn_devtunnel_host(id)`. Current `climon-remote` requires the 2-arg gateway form. Port the #123 change into the restored `main.rs`.

**Files:**
- Modify: `rust/climon-cli/src/main.rs` (`run_ingest_entry`, near the `spawn_host` closure)

- [ ] **Step 1: Inspect the restored ingest closure**

```bash
grep -n "spawn_devtunnel_host\|spawn_host\|run_ingest_entry" rust/climon-cli/src/main.rs
```

Expected: find `spawn_host: Box::new(|id: &str| climon_remote::ingest::spawn_devtunnel_host(id)),`.

- [ ] **Step 2: Confirm the current climon-remote signature**

```bash
grep -n "pub fn spawn_devtunnel_host" rust/climon-remote/src/ingest.rs
```

Expected: `pub fn spawn_devtunnel_host(` taking a gateway plus `id` (2 args).

- [ ] **Step 3: Port the closure to build a gateway and pass it (mirrors #123)**

Replace the 1-arg closure with the gateway-based form used by #123. In `run_ingest_entry`, immediately before the `IngestDaemonDeps { ... }` (or `deps`) construction, add the gateway, and update the closure:

```rust
        let host_gateway = climon_remote::devtunnel::DevtunnelGateway::new();
```

and

```rust
            spawn_host: Box::new(move |id: &str| {
                climon_remote::ingest::spawn_devtunnel_host(&host_gateway, id)
            }),
```

If the current `climon-remote` also needs the `#![allow(clippy::result_large_err)]` crate attribute that #123 put on `run.rs`, add it to the top of `main.rs` only if clippy in Task 5 flags `result_large_err`.

- [ ] **Step 4: Verify no other references to removed crates remain**

```bash
grep -rn "climon_dll\|climon-dll\|climon_stub\|climon-stub\|climon_setup\|climon-setup" rust/ scripts/ --include=*.rs --include=*.toml --include=*.ts | grep -v "climon-setup-steps"
grep -rn "pointer\|reaper" rust/climon-update/src/lib.rs
```

Expected: no matches referencing the removed crates/modules; `lib.rs` no longer declares `mod pointer;`/`mod reaper;`.

---

## Task 4: Resolve doc/changelog conflicts

**Files:**
- Modify: `docs/features.md`
- Modify: `CHANGELOG.json`

- [ ] **Step 1: Resolve docs/features.md**

Open `docs/features.md`, take the current (dev) content for unrelated rows and DELETE the rows describing the windows-binary-lifecycle feature (dedicated installer / stub / versioned payload / reaper). Remove conflict markers. Verify:

```bash
grep -n "<<<<<<<\|>>>>>>>\|=======" docs/features.md
grep -in "stub\|dedicated installer\|versioned payload\|reaper" docs/features.md
```

Expected: no conflict markers; no feature rows describing the reverted installer rework remain.

- [ ] **Step 2: Resolve CHANGELOG.json to current dev content (3.2.1 entry added in Task 7)**

Keep the existing released entries as-is (3.2.0 stays — it shipped and is historical). Just remove conflict markers, taking the dev side:

```bash
git checkout --theirs CHANGELOG.json 2>/dev/null || true
grep -n "<<<<<<<\|>>>>>>>\|=======" CHANGELOG.json
```

Note: `--theirs` here = the pre-revert (dev) content because during `git revert`, "theirs" is the working branch. If markers remain, resolve by hand keeping the current released entries. Expected: valid JSON, no markers. Validate:

```bash
node -e "JSON.parse(require('fs').readFileSync('CHANGELOG.json','utf8')); console.log('ok')"
```

---

## Task 5: Verify the Rust client builds, lints, and tests

**Files:** none (verification).

- [ ] **Step 1: Build the workspace**

```bash
cd /Users/jackallan/dev/climon/.worktrees/revert-installer-321/rust
cargo build --workspace
```

Expected: builds clean. If `spawn_devtunnel_host`/gateway mismatch errors appear, fix Task 3, Step 3 accordingly.

- [ ] **Step 2: Clippy**

```bash
cargo clippy --all-targets
```

Expected: no warnings/errors. If `result_large_err` fires on the ingest closure, add `#![allow(clippy::result_large_err)]` to the top of `rust/climon-cli/src/main.rs`.

- [ ] **Step 3: Test the Rust workspace**

```bash
cargo test
```

Expected: pass. Pay attention to `climon-install`, `climon-update`, and `rust/climon-config/tests/fixtures.rs`. Fixture/config parity should be unaffected (no config settings changed).

- [ ] **Step 4: Regenerate THIRD-PARTY-LICENSES if the revert left it stale**

The revert restores `rust/THIRD-PARTY-LICENSES.md` to its pre-feature state. Regenerate to match the actual (reverted) dependency set:

```bash
cd /Users/jackallan/dev/climon/.worktrees/revert-installer-321/rust
cargo about generate about.hbs -o THIRD-PARTY-LICENSES.md || echo "cargo-about not installed; install with: cargo install cargo-about"
cargo deny check || echo "review cargo deny output"
```

Expected: `THIRD-PARTY-LICENSES.md` regenerated; `cargo deny` passes. If `cargo about`/`cargo deny` are unavailable locally, note it and rely on CI, but confirm the committed file matches the reverted deps.

---

## Task 6: Verify Bun packaging (zip layout back to v3.1.3)

**Files:** none (verification).

- [ ] **Step 1: Confirm compile.ts zip entry naming no longer emits a pure installer as `install`**

```bash
cd /Users/jackallan/dev/climon/.worktrees/revert-installer-321
grep -n "zipEntryNamesForPlatform\|install\b\|climon-server\|legacy" scripts/compile.ts | head -30
git diff v3.1.3 -- scripts/compile.ts | head -5   # expect no meaningful diff for entry naming
```

Expected: packaging matches v3.1.3 — the zip entry old updaters map onto `climon` is the real client binary, not an installer stub.

- [ ] **Step 2: Run the packaging-related tests**

```bash
bun test tests/windows-installer-package.test.ts
```

Expected: pass (or the reverted assertions match v3.1.3 behavior). Also run any install-fixture parity test:

```bash
bun test tests/install-manifest.test.ts 2>/dev/null || true
node -e "JSON.parse(require('fs').readFileSync('fixtures/install/manifest.json','utf8')); console.log('manifest ok')"
```

Expected: green; `fixtures/install/manifest.json` restored to v3.1.3 shape.

---

## Task 7: Add the 3.2.1 CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.json`

Follow the repo `update-changelog` skill conventions. Do NOT bump `package.json` (the Release workflow patch-bumps to 3.2.1 automatically on merge to `main`).

- [ ] **Step 1: Insert the 3.2.1 entry at the top of the array**

```json
  {
    "version": "3.2.1",
    "changes": [
      "Revert the Windows self-update stub/installer rework from 3.2.0 that caused clients updating from 3.1.x to overwrite `climon` with the installer and break"
    ]
  },
```

Add a second line only if other user-facing fixes are also shipping in 3.2.1 (there are none planned). Validate JSON:

```bash
node -e "JSON.parse(require('fs').readFileSync('CHANGELOG.json','utf8')); console.log('ok')"
```

Expected: valid JSON, 3.2.1 entry first.

---

## Task 8: Commit, push, and open the PR to dev

**Files:** none (git).

- [ ] **Step 1: Stage and commit**

```bash
cd /Users/jackallan/dev/climon/.worktrees/revert-installer-321
git add -A
git commit -m "revert: back out windows-binary-lifecycle installer rework for 3.2.1

Reverts PR #97 (5e3caf57). Pre-3.2.0 updaters map the zip 'install' entry
onto 'climon'; 3.2.0 made 'install' a pure installer stub, so updating from
<=3.1.x overwrote climon with the installer and broke it. Restores v3.1.3
packaging + self-update behavior. Feature commits preserved on
feat/windows-binary-lifecycle for later rework.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: e77f5e78-86d5-4e9a-85e5-e47974d99b3b"
```

- [ ] **Step 2: Push and open the PR against dev**

```bash
git push -u origin fix/revert-installer-321
gh pr create --base dev --head fix/revert-installer-321 \
  --title "Revert windows-binary-lifecycle installer rework (3.2.1)" \
  --body "Reverts PR #97. Fixes the 3.2.0 update regression where clients on <=3.1.x overwrite \`climon\` with the installer stub. Restores v3.1.3 packaging/update behavior. Feature commits preserved on \`feat/windows-binary-lifecycle\`. Version 3.2.1 is auto-bumped by the Release workflow on merge to main."
```

Expected: PR opened against `dev`. Wait for CI to pass.

- [ ] **Step 3: Squash-merge into dev once green**

```bash
gh pr merge --squash --delete-branch
```

Expected: single squash commit on `dev` (per repo convention).

---

## Task 9: Cut the 3.2.1 release (dev → main)

**Files:** none (git/gh).

- [ ] **Step 1: Open the release PR from dev to main**

```bash
cd /Users/jackallan/dev/climon
git fetch origin
gh pr create --base main --head dev \
  --title "Release 3.2.1: revert windows-binary-lifecycle installer rework" \
  --body "Cuts 3.2.1. Reverts the 3.2.0 installer/self-update stub rework that broke updates from 3.1.x. Release workflow patch-bumps to 3.2.1 and tags on merge."
```

- [ ] **Step 2: Merge dev → main with a REAL merge commit (never squash)**

```bash
gh pr merge --merge
```

Expected: real merge commit on `main`; the Release workflow triggers, patch-bumps to 3.2.1, tags `v3.2.1`, builds/signs/publishes.

- [ ] **Step 3: Confirm the release**

```bash
gh run list --workflow=release.yml --limit 3
gh release view v3.2.1 2>/dev/null || echo "release still building"
```

Expected: Release workflow runs; `v3.2.1` tag + release appear when finished.

---

## Task 10: Cleanup

- [ ] **Step 1: Remove the worktree once merged**

```bash
cd /Users/jackallan/dev/climon
git worktree remove .worktrees/revert-installer-321
```

Expected: worktree removed; `feat/windows-binary-lifecycle` remains on origin for later rework.

---

## Self-review notes

- Spec coverage: preserve feature (Task 1) ✓; full revert (Tasks 2–4) ✓; compile against current deps (Task 3) ✓; verify client + packaging (Tasks 5–6) ✓; 3.2.1 changelog (Task 7) ✓; dev PR squash (Task 8) ✓; dev→main real-merge release (Task 9) ✓.
- Version bump is deliberately NOT manual (workflow patch-bumps + updates fixtures on main). If CI on the dev PR fails on CLI fixture parity, STOP and reconsider — it would mean fixtures expect a bumped version at PR time; in that case bump via `bun run release` to 3.2.1 on the branch instead.
- Risk: if the restored `main.rs` needs more than the ingest closure port (e.g., other post-#97 API drift), Task 5 build errors will surface them; fix minimally in `main.rs` to match current `climon-remote`/`climon-update` APIs, keeping v3.1.3 behavior.
