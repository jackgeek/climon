# Daemon Actor Parallel Cross-Platform Release-Gate Handoff

## Objective

Complete the `DAR-01` through `DAR-10` actor manual-test matrix on Windows,
Linux, and macOS using one immutable source candidate. Run one test agent per OS
in parallel, preserve honest evidence for every cell, and fix any actor-relevant
defect with strict TDD before resuming the matrix.

Do **not** make the actor engine the default. Do **not** merge any branch without
explicit user approval. Legacy is a diagnostic control only; do not spend
release-gate time fixing legacy-only behavior.

## Coordinator workspace and candidate

- Repository: `jackgeek/climon`
- Coordinator worktree:
  `C:\git\climon\.worktrees\fix-windows-browser-handoff-replay`
- Branch: `fix/windows-browser-handoff-replay`
- Branch HEAD before this handoff:
  `ba48be542fba00d84726414005838f4c64444ae8`
- Immutable source candidate:
  `98bb7e1aef488bd700d9937086b704aa647c2873`
- Commits after the source candidate are documentation-only:
  - `5e22787c` records the Windows DAR-03 pass.
  - `ba48be54` clarifies which DAR-03 run was authoritative.
- Windows candidate binary already tested for DAR-03:
  `rust\target\release\climon.exe`
- Windows candidate SHA-256:
  `E454BC34278925C6E29F7A33A02A544F50A68243EA7FB50020D79A0F972E3965`

All OS agents must detach at `98bb7e1a` before building. Documentation commits
may be added to the coordinator branch without changing the source candidate.
If any product source, dependency, fixture, generated runtime asset, or build
script changes, the source candidate is invalidated immediately.

Before dispatching remote OS agents, make the candidate available to them
without merging it. If this requires pushing the feature branch, ask the user
for approval, push only `fix/windows-browser-handoff-replay`, and do not open or
merge a PR.

## Authoritative documents

Read these before testing:

- `docs/manual-tests/daemon-actor-rewrite.md` — canonical `DAR-01` through
  `DAR-10` procedures and expected results.
- `docs/manual-tests/results/windows.md` — current Windows evidence.
- `docs/manual-tests/results/linux.md` — historical Linux evidence and known
  gaps.
- `docs/manual-tests/results/macos.md` — historical macOS evidence.
- `docs/manual-tests/terminal-control-handoff.md` — TCH-14 browser/Tunnel Link
  handoff regression.
- `docs/superpowers/specs/2026-07-21-windows-browser-handoff-replay-design.md`
  — current browser handoff recovery design.

If this handoff conflicts with the canonical manual test, stop and resolve the
documentation conflict before classifying a result.

## Current matrix status

Existing results are valuable diagnostic history, but only Windows DAR-03 was
run against the current source candidate.

| Platform | Current-candidate status | Work required |
|---|---|---|
| Windows | DAR-03 Pass at `98bb7e1a`; all other rows are old Blocked/Partial evidence | Run DAR-01, DAR-02, and DAR-04 through DAR-10. Preserve DAR-03 unless the candidate changes. |
| Linux | Historical run used `68bc1cf7`; DAR-04 and DAR-09 were Partial and DAR-08 failed before remediation | Run all ten rows at `98bb7e1a`. |
| macOS | Historical rows pass, mostly at `77cbc91b`, but no same-candidate sweep exists | Run all ten rows at `98bb7e1a`. |

The gate is complete only when all 30 platform cells are Pass on one source
candidate. A Blocked, Partial, Fail, or untested cell keeps the gate closed.

## Parallel execution model

Use one coordinator and three independent OS test agents:

1. **Coordinator**
   - Owns candidate identity, stop/resume decisions, consolidated status, code
     remediation, and all repository result-file edits.
   - Creates a durable ledger outside the candidate checkout with one row per
     OS/DAR cell.
   - Receives evidence reports from the OS agents.
   - Is the only agent allowed to commit result files.
2. **Windows test agent**
   - Runs DAR-01, DAR-02, and DAR-04 through DAR-10.
   - May sanity-check DAR-03, but must not replace its recorded Pass without new
     contradictory evidence.
3. **Linux test agent**
   - Runs DAR-01 through DAR-10.
   - Must close the historical DAR-04 frame-caching-TUI gap and directly isolate
     the DAR-09 SIGWINCH path.
4. **macOS test agent**
   - Runs DAR-01 through DAR-10.
   - Must use a real interactive terminal and browser/PWA surface, even though
     historical rows passed.

OS agents test from detached, clean candidate checkouts and write evidence only
to external directories. They must not edit source, result files, or the shared
coordinator branch.

### Parallel stop barrier

An OS agent must report `FAIL` immediately when a core assertion is exercised
and is wrong. It must report `BLOCKED` when the environment prevents a core
assertion. On either status:

1. Preserve the failing session's entire `CLIMON_HOME`, screenshots, logs,
   metadata, scrollback, exact command transcript, and candidate hash.
2. Run the smallest equivalent legacy control only when it helps classify the
   defect as actor-only or shared.
3. Notify the coordinator and stop that DAR row.
4. The coordinator tells all OS agents to pause at their next safe boundary.
5. Do not continue accumulating release-gate Passes against a candidate already
   known to be defective.

## Candidate invalidation and remediation

When a product defect is found:

1. Keep the immutable candidate checkouts and evidence untouched.
2. Create one focused remediation worktree/branch under `.worktrees/`.
3. Use `systematic-debugging`, then strict `test-driven-development`.
4. Reproduce the smallest actor case.
5. Use legacy only as a control; do not remediate a legacy-only issue.
6. Add a deterministic failing regression test and capture RED.
7. Implement the minimal root-cause fix.
8. Run the focused test, surrounding suite, actor control, and relevant legacy
   diagnostic control.
9. Commit and independently review the fix.
10. Publish one new immutable candidate SHA to all OS agents.

Every Pass recorded against the old candidate becomes historical evidence.
Rerun all cells whose code path or shared runtime could be affected. If the
impact cannot be bounded confidently, rerun all completed cells on all three
platforms. The final report must contain only one candidate in its Pass rows.

## Common test setup

Each OS agent must use:

- A clean detached checkout at `98bb7e1a`.
- The branch-built Rust client, never a globally installed `climon`.
- A fresh external `CLIMON_HOME`; never delete an earlier evidence directory.
- `CLIMON_SESSION_ENGINE=actor` except for explicit selector or diagnostic
  controls.
- A real interactive terminal/console for attached assertions.
- A real browser driven by Playwright where practical.
- PTY tooling where practical, but not as a substitute for a real Windows
  console record path.
- A normal dashboard plus a PWA surface. The repository-approved PWA simulation
  is **Menu → Tunnel Link → Open link**; treat the opened tunnel dashboard as
  the PWA surface.

Record before testing:

- Full commit SHA and clean `git status`.
- OS edition/version, architecture, terminal version, browser version, Bun,
  Rust, Cargo, and Copilot CLI versions.
- Exact build command and binary hash.
- `CLIMON_HOME` path and dashboard URL.

Build from the detached candidate:

```powershell
bun install
bun run build:web
Push-Location rust
cargo build --release -p climon-cli
Pop-Location
```

On Linux/macOS, use the equivalent shell commands and record a SHA-256 of the
resulting `rust/target/release/climon`.

## Evidence contract

Create an external evidence root per platform, for example:

```text
<temp>/climon-dar-98bb7e1a-<platform>-<timestamp>/
```

For every DAR cell record:

- Candidate SHA and binary SHA-256.
- Tester, OS, architecture, terminal, browser/PWA, and tool versions.
- Exact commands and environment variables.
- Session ID or IDs.
- Relevant metadata before and after each assertion.
- Final scrollback and relevant log excerpts.
- The uniquely resolved `climon __session <id>` host PID for lifecycle checks.
  Metadata `daemonPid` is the PTY child PID, not the daemon host.
- Listener/socket state where teardown is asserted.
- Screenshots for rendering, control, title/progress, attention, and
  multi-viewer assertions.
- Actor result and any legacy diagnostic-control result.
- One classification: Pass, Fail, Blocked, or Partial.

Result rules:

- **Pass:** every core assertion was directly observed.
- **Fail:** a core assertion was exercised and behaved incorrectly.
- **Blocked:** the environment or prerequisite prevented a core assertion.
- **Partial:** independent assertions passed while another independent assertion
  was not exercised. Never use Partial to soften a failure.

Each OS agent returns a structured report containing an environment header, a
ten-row table, preserved-evidence paths, defects/blockers, and the next safe
action. The coordinator reviews evidence before editing repository reports.

## Platform launch briefs

### Windows agent

Required environment:

- Windows x64 desktop.
- Windows Terminal and PowerShell 7.
- Visual Studio 2022 C++ Build Tools and Windows SDK.
- Chrome or Edge.
- `vim` and Copilot CLI for DAR-01/DAR-04.
- Playwright MCP and PTY MCP when applicable.

Run in this risk-first order so shared ConPTY/lifecycle defects surface early:

1. DAR-01 — attached Unicode input, full-screen TUI, exit, and console-mode
   restoration.
2. DAR-07 — fast success/failure exit, exact codes, final scrollback, listener
   release.
3. DAR-02 — mid-stream replay followed by visible live output and clean exit.
4. DAR-04 — Vim restore plus same-size Copilot frame-caching repaint.
5. DAR-06 — OSC title/progress persistence, dashboard rendering, passthrough,
   and clear.
6. DAR-08 — one throttled/disconnected viewer while healthy viewer and local
   console continue visibly through completion.
7. DAR-05 — attention, durable acknowledgement, real body change, re-flag, and
   resize stickiness.
8. DAR-09 — Windows Terminal resize poller plus expected forced-host
   termination/reconciliation behavior.
9. DAR-10 — default/actor/legacy equivalence and invalid selector behavior.
10. DAR-03 — already Pass on this candidate; rerun only as a sanity check or
    after candidate invalidation.

Do not classify a Windows attached assertion from redirected stdin/stdout or
socket-byte injection. Space reclaim and console restoration require a real
Windows Terminal/OpenConsole surface.

### Linux agent

Required environment:

- Linux x64 with a real controlling PTY.
- Browser and PWA/Tunnel Link surface.
- `vim` and Copilot CLI.
- Permission to deliver signals to the verified daemon host.

Run all ten canonical rows. Pay particular attention to:

- DAR-04: use Copilot or another Ink-style frame-caching TUI for the same-size
  repaint subcase; Vim alone is insufficient.
- DAR-08: prove a healthy viewer visibly advances after another viewer is
  throttled or disconnected, and verify no `vt100` panic or stale metadata.
- DAR-09: directly deliver SIGINT, SIGTERM, and SIGWINCH to the correct paths.
  Resolve the daemon host from `__session <id>` immediately before each host
  signal; never signal metadata `daemonPid`.
- If a sandbox rejects controlling-terminal `setsid`, record the environment
  limitation and use `CLIMON_DISABLE_SETSID=1` only where documented. A real PTY
  remains mandatory for attached assertions.

### macOS agent

Required environment:

- macOS with a real interactive terminal.
- Browser and PWA/Tunnel Link surface.
- `vim` and Copilot CLI.
- Permission to deliver SIGINT/SIGTERM and resize the terminal.

Run all ten canonical rows. Pay particular attention to:

- DAR-01: verify `ECHO`, `ICANON`, `ISIG`, and `IEXTEN` restoration and queued
  input preservation. Do not fail solely on the transient `PENDIN` status bit.
- DAR-04: include the same-size Copilot frame-caching repaint.
- DAR-05: leave a persistent changed screen body before checking
  `acknowledged → running → needs-attention`.
- DAR-08: use two real browser surfaces and prove the healthy path advances
  after the other disconnects.
- DAR-09: resolve and signal the `climon __session <id>` host, not
  `daemonPid`; directly exercise terminal resize/SIGWINCH.

## Automated candidate gates

The coordinator runs these once before dispatch and again for the final
candidate after all manual cells pass:

```powershell
Push-Location rust
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
cargo build --release -p climon-cli
Pop-Location

bun run typecheck
bun test tests/config-settings.test.ts tests/config-fixtures.test.ts
bun test tests/handoff-replay.test.ts tests/terminal-view.test.ts tests/terminal-replay.test.ts
bun run build:web
```

Record exact output and failures. Fix only candidate-caused failures; do not
hide baseline or environment failures.

## Coordinator result integration

After reviewing an OS report, update only:

- `docs/manual-tests/results/windows.md`
- `docs/manual-tests/results/linux.md`
- `docs/manual-tests/results/macos.md`

All final Pass rows must name the same source candidate. Include concise
evidence paths or hashes without committing secrets, tunnel tokens, or raw
runtime state. Keep screenshots outside the repository unless the user asks to
archive them.

Before each result commit:

```powershell
git diff --check
git diff -- docs/manual-tests/results
git status --short
```

Commit platform reports separately with the required trailer:

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

Do not merge. Do not flip the actor default. Do not claim the gate passed until
all 30 cells are Pass on the final candidate and the final automated gates pass.

## Completion criteria

The handoff is complete only when:

1. Windows, Linux, and macOS reports each contain Pass for DAR-01 through DAR-10.
2. Every Pass row names one final immutable source candidate.
3. All required real terminal, browser/PWA, signal, resize, lifecycle, and
   multi-viewer assertions were directly observed.
4. No row is Blocked, Partial, Fail, or untested.
5. Final automated gates pass on that candidate.
6. Independent task and whole-branch reviews report no open Critical or
   Important findings.
7. The feature branch is pushed if requested, but remains unmerged until the
   user explicitly approves the merge.

## Immediate next action

The fresh coordinator agent should:

1. Verify the worktree and candidate identities above.
2. Run the automated baseline gates at `98bb7e1a`.
3. Create the external 30-cell evidence ledger.
4. Prepare one complete task brief per OS from the platform sections above.
5. Dispatch the Windows, Linux, and macOS test agents in parallel.
6. Stop at the first reported defect barrier, or consolidate results when all
   three agents return.
