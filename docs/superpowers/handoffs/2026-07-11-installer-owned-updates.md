# Installer-Owned Updates Handoff

Date: 2026-07-11
Branch: `fix/windows-bootstrap-migration`
Worktree: `.worktrees/windows-bootstrap-migration`
Current HEAD: `20775e4`
Status: Tasks 1-2 complete and reviewed; stop before Task 3

## Start here

Read these documents in order:

1. `docs/superpowers/specs/2026-07-11-installer-owned-updates-design.md`
2. `docs/superpowers/plans/2026-07-11-installer-owned-updates.md`
3. This handoff

Continue with the `subagent-driven-development` skill. Dispatch a fresh
implementer for each remaining task, followed by spec-compliance review and then
code-quality review. Do not skip or reorder those review stages.

The plan has ten tasks. Tasks 1 and 2 are complete. Start at:

```text
Task 3: Make normal updates delegate and enforce the boundary
```

## Approved architecture

The permanent rule is:

```text
old/current client:
  fetch -> download -> verify complete signed ZIP -> safe stage -> invoke install

new artifact's installer:
  validate source -> decide layout -> place/migrate -> cleanup
```

The old client must never dictate the new client's installed layout.

Every release archive retains one stable entrypoint:

- Windows: `install.exe`
- macOS/Linux: `install`

Current Unix archives remain:

```text
install
climon
climon-server
```

Current Windows archives remain:

```text
install.exe
climon.dll
climon-server.exe
```

There are two authenticated downloads during legacy migration:

1. the already-shipped client verifies the signed ZIP containing the installer
   before it copies `install[.exe]` over `climon[.exe]`;
2. that renamed installer enters bootstrap mode, redownloads the canonical
   artifact, and independently verifies it before extraction or execution.

There must be no unsigned installer execution path.

## Completed work

### Design and plan

- `9c72c3d` — cross-platform installer-owned update design
- `854d5b6` — explicit signed two-hop security contract
- `0e92f5d` — ten-task implementation plan

The rejected bridge-release design was removed. Do not restore or implement it.
No intermediate release adoption is allowed as a migration requirement.

### Task 1: Authenticated artifact staging

Commits:

- `336f7c4` — shared verified artifact staging
- `9c45acb` — special ZIP entry coverage
- `3755249` — harden staged entry lookup against traversal/symlinks

Implemented in `rust/climon-update/src/artifact.rs`:

- bounded artifact and detached-signature download;
- Ed25519 verification over the complete ZIP before extraction;
- safe ZIP extraction;
- explicit rejection of absolute, parent, Windows-prefixed, backslash-rooted,
  symlink, FIFO, device, socket, and other special entries;
- Unix executable-mode preservation;
- `StagedArtifact::root`, safe `entry`, and `keep`;
- cleanup on drop/error unless ownership is transferred.

`rust/climon-update/src/update_cmd.rs` still applies updates using the old
layout-owned logic. Only its unzip implementation was routed through the safe
extractor. Task 3 removes that old application logic.

Reviews:

- spec review approved after adding a non-symlink special-entry test;
- quality review approved after closing `StagedArtifact::entry` traversal and
  symlink escapes.

Validation at Task 1 completion:

```text
cargo test -p climon-update: 89 passed
cargo fmt --check: passed
```

### Task 2: Versioned installer protocol and placement ownership

Commit:

- `20775e4` — installer-owned update protocol and placement

Implemented in `rust/climon-install/src/update.rs` and installer dispatch:

- strict `OsString` parsing for:
  - `--apply-update-v1`
  - `--recover-bootstrap-v1`
- typed `ApplyUpdateArgs`, `RecoverBootstrapArgs`, and `UpdateOperation`;
- exact common `--dir`, `--source`, and `--version` parsing;
- recover PID, fallback, and repeated original-argument parsing;
- rejection of conflicting, duplicate, missing, invalid, and unknown flags;
- update-operation dispatch before normal UTF-8 onboarding parsing;
- explicit nonzero rejection of recovery for now, because Tasks 4-6 wire it;
- installer build-version equality check before mutation;
- complete payload preflight before mutation;
- installer-owned Unix atomic rename-over:
  - server first;
  - client last as commit point;
  - executable mode, fsync, macOS quarantine removal;
  - `.version` after successful placement;
  - open old inode remains valid;
- installer-owned Windows versioned payload/stub placement;
- atomic pointer writes with pointers last;
- post-success retired-file cleanup.

Fresh installer behavior is preserved.

Reviews:

- spec review approved; advisory only: duplicate `--fallback` rejection is
  implemented but does not have its own dedicated test;
- code-quality review approved with no findings.

Validation at Task 2 completion:

```text
cargo test -p climon-install: 131 passed
cargo test -p climon-update: 89 passed
cargo fmt --check: passed
cargo clippy: passed
```

## Repository state

The worktree was clean immediately after `20775e4`.

Before changing anything, verify:

```bash
cd /Users/jackallan/dev/climon/.worktrees/windows-bootstrap-migration
git status --short
git branch --show-current
git --no-pager log -5 --oneline
```

Expected branch:

```text
fix/windows-bootstrap-migration
```

Expected HEAD:

```text
20775e4 feat(install): own versioned update placement
```

## Next task: updater delegation

Execute Task 3 exactly as written in the plan.

The goal is to reduce `rust/climon-update/src/update_cmd.rs` to:

1. version/artifact selection;
2. authenticated staging through `artifact.rs`;
3. locating the stable `install[.exe]`;
4. invoking:

```text
--apply-update-v1
--dir <installed directory>
--source <verified staging directory>
--version <manifest version>
```

5. treating installer nonzero exit as update failure.

Task 3 must remove updater-owned layout policy:

- delete `rust/climon-update/src/install_manifest.rs`;
- delete `rust/climon-update/src/swap.rs`;
- remove direct Windows versioned payload writes;
- remove pointer writes from updater application code;
- remove Unix destination loops and atomic replacements from updater application;
- remove bridge migration helpers;
- keep only pointer reading required by the separate Windows reaper;
- add `rust/climon-update/tests/architecture.rs`.

The architecture test must reject layout names and direct-placement APIs in
`update_cmd.rs` and `update_cli.rs`, including:

```text
climon.dll
climon-server.exe
climon.version
climon-server.version
write_pointer
replace_file_atomic
place_windows_layout
install_files_for_platform
std::fs::rename
std::fs::write
```

Do not begin bootstrap basename dispatch in Task 3. That is Task 4.

## Remaining task order

1. Task 3 — updater delegation and architecture enforcement
2. Task 4 — installer versus legacy-bootstrap basename dispatch
3. Task 5 — Unix bootstrap recovery and automatic command resume
4. Task 6 — Windows detached recovery and `.old` fallback
5. Task 7 — packaging stability and test-endpoint isolation
6. Task 8 — cross-platform direct-migration harness and CI
7. Task 9 — manual tests, architecture/security/features/changelog docs
8. Task 10 — full verification and final reviews

Do not pause between tasks unless blocked or a user asks to stop. The current
user explicitly requested this handoff checkpoint, so this agent stopped after
Task 2 rather than continuing automatically.

## Important implementation constraints

- All work remains in the existing worktree; do not create another worktree.
- Client work belongs in the Rust workspace.
- Use TDD for every implementation task.
- Never execute extracted content before successful signature verification.
- Treat archive paths and remote metadata as untrusted.
- Pass command arguments directly with `Command`; never use a shell.
- Production binaries must not contain an active manifest endpoint override.
- The test endpoint feature is compiled only for upgrade harness builds.
- Windows recovery must never call the old `update` recursively.
- Windows fallback is derived only from local
  `<install-dir>/climon.exe.old`; never accept a network-controlled fallback.
- Unix migration has a one-time network requirement and resumes the original
  command after successful repair.
- Windows migration exits to release the executable lock, repairs in a child,
  and asks the user to rerun.
- Installer owns all future layout evolution.

## Known baseline context

At the start of implementation:

```text
cargo test --workspace: 66 passed
bun test tests/windows-installer-package.test.ts tests/upgrade-harness.test.ts:
10 passed
```

The repository has known full-suite environmental/order-dependent Bun failures
and a known macOS `climon-remote::shutdown_watch` timing flake. Do not change
unrelated code to address those unless the current branch demonstrably causes a
new failure.

## Commit requirements

Every commit created by the next agent must include:

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 513640df-6eca-46e0-bc9e-da5a72e8a3e1
```

After all tasks and reviews complete, use the
`finishing-a-development-branch` skill. PRs target `dev`, never `main`.
