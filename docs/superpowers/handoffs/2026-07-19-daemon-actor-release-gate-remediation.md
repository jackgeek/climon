# Daemon Actor Release-Gate Remediation Handoff

## Goal

Resolve the defects and coverage gaps found by the Linux, macOS, and Windows
manual-test runs for the idiomatic Rust daemon rewrite. Do **not** make the
actor engine the default until every required `DAR-*` cell has passed on the
same release candidate.

## Workspace and branch

- Repository: `/Users/jackallan/dev/climon`
- Worktree:
  `/Users/jackallan/dev/climon/.worktrees/fix-daemon-actor-release-gate`
- Branch: `fix/daemon-actor-release-gate`
- Upstream: `origin/design/idiomatic-daemon-rewrite`
- Current HEAD: `c63f2450`
- Status at handoff: clean before this document; branch is one commit ahead of
  upstream.

The canonical rewrite branch contained the Linux and Windows reports but not
the macOS report. This branch was created from
`origin/design/idiomatic-daemon-rewrite` at `f4e34fcc`, then cherry-picked the
macOS-only result commit `f1404dc7` as `c63f2450`. All three reports now exist
in one worktree:

- `docs/manual-tests/results/linux.md`
- `docs/manual-tests/results/macos.md`
- `docs/manual-tests/results/windows.md`

Do not merge the divergent
`origin/design/idiomatic-daemon-rewrite-harness` branch wholesale. It contains
substantial unrelated harness and repository changes.

## Current release-gate status

The actor default must remain disabled.

### Linux

- Nine rows are recorded as Pass and DAR-08 is Fail.
- DAR-08 reproducibly panics in `vt100` while updating the shared
  `HeadlessGrid`, kills the session, and leaves metadata stuck at `running`.
- The same panic reproduces in the legacy engine, so it is a shared terminal
  fingerprint defect rather than an actor-only regression. It still blocks the
  actor release gate.
- DAR-04 overstates coverage: `vim` was substituted for the intended
  frame-caching Ink/Copilot case.
- DAR-09 contains contradictory wording about whether SIGWINCH was blocked or
  implicitly exercised.
- DAR-05 correctly observed that `climon config attention.idleSeconds 3` is
  rejected. The setting exists but lacks `.accept_input()`.

Evidence:

- `docs/manual-tests/results/linux.md:47-147`
- `rust/climon-session/src/fingerprint.rs`
- `rust/climon-session/src/domain/terminal.rs:61-96`
- `rust/climon-config/src/config_settings.rs:343-349`

### macOS

- Seven rows are Pass; DAR-01, DAR-05, and DAR-08 are recorded as Fail.
- DAR-08 is the real blocker: the host exits and the socket closes while
  metadata remains `running`.
- DAR-01 changed only the macOS `PENDIN` termios status bit
  (`0x20000000`). Functional cooked-mode flags were restored. Reproduce before
  changing `RawMode`; determine whether this is unread pending input, a test
  criterion issue, or a real restoration defect.
- DAR-05 is partly misclassified. User acknowledgement intentionally produces
  `acknowledged`, not `running`, in both actor and legacy engines. The manual
  test text is wrong. The reported failure to re-flag after genuinely changed
  output still needs a controlled reproduction.

Evidence:

- `docs/manual-tests/results/macos.md:17-28`
- `docs/manual-tests/daemon-actor-rewrite.md:274-297`
- `rust/climon-session/src/domain/attention.rs:208-224`
- `rust/climon-session/src/idle.rs`
- `rust/climon-pty/src/term.rs:22-64`

### Windows

- The gate is not close to passing: attached-console cases are blocked and most
  remaining rows are partial.
- The run used a non-interactive process transport, not a real Windows console,
  and no installed PWA was available.
- DAR-02, DAR-06, DAR-07, and DAR-08 share blank/live-output and non-exit
  symptoms. DAR-06 should not be treated as a confirmed title/progress product
  bug until actor and legacy controls run in a real interactive console.
- DAR-09 correctly documents forced host termination leaving stale metadata,
  followed by `climon kill` reconciliation.

Evidence:

- `docs/manual-tests/results/windows.md:8-34`

## Highest-priority defect: shared `HeadlessGrid` panic

Observed stack:

```text
vt100::grid::Grid::col_wrap
vt100::screen::Screen::text
climon_session::fingerprint::HeadlessGrid::write
climon_session::domain::terminal::TerminalModel::apply_output
climon_session::engine::state::SessionState::apply
climon_session::engine::coordinator::Coordinator::apply_event
```

The Linux report contains the full reproduction and stack trace. It was
observed with:

- sustained high-volume output,
- multiple browser viewers,
- both slow and normally-reading viewers,
- repeated attach/detach and control handoffs,
- actor and legacy engines.

Do not add a broad `catch_unwind` around normal terminal processing as the
primary fix. First reduce the terminal byte/resize/attach sequence to a
deterministic failing test against `HeadlessGrid` or `TerminalModel`, identify
the invalid `vt100` grid state, and fix the state transition at its source.

## Required execution order

### Task 1: Reproduce and fix the shared terminal-grid panic

1. Use `superpowers:systematic-debugging`.
2. Capture or minimize the terminal byte and resize sequence that reaches
   `vt100::grid::Grid::col_wrap`.
3. Add the smallest failing test in:
   - `rust/climon-session/src/fingerprint.rs`, or
   - `rust/climon-session/src/domain/terminal.rs`.
4. Verify RED for the exact panic.
5. Compare with working resize/output sequences and inspect the `vt100 0.16.2`
   invariant before selecting a fix.
6. Implement one root-cause fix.
7. Run the regression repeatedly and run both actor and legacy parity suites.

Potential outcomes include correcting a resize/write ordering invariant,
sanitizing an invalid size/cursor transition, or upgrading/patching `vt100`.
Do not choose among them until the minimized reproduction identifies the
cause.

### Task 2: Make abnormal actor teardown persist terminal metadata

Even after the panic is fixed, the supervisor must not leave a session
permanently `running` when the coordinator or another required task fails.

1. Add a failing supervisor test where the coordinator ends or panics before
   `CompleteSession`.
2. Assert the backend receives one terminal failure patch before socket cleanup.
3. Add a narrow teardown fallback for
   `CoordinatorEnded`/`RequiredTaskFailed`.
4. Preserve normal ordered finalization; the fallback must run only when the
   coordinator cannot complete it.
5. Verify no duplicate terminal patch on normal exit.

Relevant code:

- `rust/climon-session/src/engine/supervisor.rs:672-710`
- `rust/climon-session/src/engine/supervisor.rs:869-883`
- `rust/climon-session/src/engine/state.rs`
- `rust/climon-store/src/patch.rs`

### Task 3: Correct attention configuration and manual semantics

1. Add a failing config-registry test proving
   `attention.idleSeconds` should be accepted as user input.
2. Add `.accept_input()` in both configuration registries/parity surfaces as
   required by repository conventions.
3. Regenerate:
   - `fixtures/config/*` via `bun scripts/gen-config-fixtures.ts`
   - config docs/comments via `bun run docs:config`
4. Update DAR-05 to expect `acknowledged` after user acknowledgement.
5. Add a deterministic test/manual procedure that changes the fingerprint body
   before waiting for re-flagging; do not rely on transient output that settles
   back to the same visible screen.

Relevant code:

- `rust/climon-config/src/config_settings.rs:343-349`
- `src/config-settings.ts`
- `rust/climon-session/src/domain/attention.rs`
- `rust/climon-session/src/idle.rs`
- `docs/manual-tests/daemon-actor-rewrite.md`

### Task 4: Characterize macOS `PENDIN`

1. Add or use a real-PTY integration test that records termios before actor
   setup and after `LocalTerminalSetup::shutdown`.
2. Reproduce the `PENDIN` delta with controlled unread input.
3. Confirm cooked-mode flags (`ECHO`, `ICANON`, `ISIG`, `IEXTEN`) restore.
4. Only change `RawMode` if the product leaves a meaningful mode or pending
   input defect. Otherwise update DAR-01 to compare functional modes rather
   than transient kernel status bits.

Do not switch blindly from `TCSANOW` to `TCSAFLUSH`: that can discard user
input and must be justified by a failing behavior test.

### Task 5: Correct result classifications before reruns

Update reports only after the corresponding evidence is reviewed:

- Linux DAR-04: Partial/Blocked until tested with the intended frame-caching
  TUI.
- Linux DAR-09: reconcile the SIGWINCH contradiction.
- macOS DAR-05: separate the incorrect `running` expectation from the
  re-flagging observation.
- Windows DAR-06: downgrade to Blocked/Partial unless a real-console actor vs
  legacy control proves a title/progress defect.
- Windows DAR-08: the core backpressure-isolation assertion was not exercised.

Do not turn failures green by editing labels.

### Task 6: Re-run the manual matrix on one candidate commit

After automated fixes and reviews:

- Linux:
  - rerun DAR-08,
  - run DAR-04 with the intended Ink/Copilot-style frame-caching TUI,
  - directly verify the SIGWINCH path for DAR-09.
- macOS:
  - rerun DAR-01, DAR-05, and DAR-08.
- Windows:
  - use a real interactive Windows console,
  - run actor and legacy controls for the shared ConPTY lifecycle symptoms,
  - include an installed PWA,
  - rerun every Blocked/Partial/Fail row.

Every report must name the same tested commit. Do not flip the default while
any required row is Fail, Blocked, Partial, or untested.

### Task 7: Flip the default only after the gate is green

Follow Task 18 in:

`docs/superpowers/plans/2026-07-17-idiomatic-rust-daemon-rewrite.md`

Change the selector test first, verify RED, then make actor the default while
retaining explicit `CLIMON_SESSION_ENGINE=legacy` rollback.

## Workflow requirements

- Use strict TDD for every code fix.
- Use `superpowers:subagent-driven-development`.
- After each implementation task, run an independent spec review followed by
  an independent code-quality review.
- Run the smallest targeted test first, then:

```bash
cd rust
cargo test -p climon-session
cargo test -p climon-config
cargo build --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

- For config changes also run the Bun config parity tests after regenerating
  fixtures.
- Keep `.superpowers/` untracked.
- Do not merge or open a merge operation without explicit approval.
- PRs target `dev`; squash merge into `dev` only after explicit approval.

## Immediate next action

Start Task 1 only. Investigate and minimize the `HeadlessGrid` panic before
editing production code.
