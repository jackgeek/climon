# Windows Daemon Actor Release-Gate Handoff

## Goal

Run the complete `DAR-01` through `DAR-10` Windows matrix from a real,
interactive Windows console, replace the blocked/partial Windows results with
honest evidence, and fix any Windows defects using strict TDD.

Do **not** make the actor engine the default. Do **not** merge this branch. The
release gate remains closed until every required macOS, Windows, and Linux cell
passes against one code candidate.

## Candidate and branch

- Repository: `jackgeek/climon`
- Branch: `fix/daemon-actor-release-gate`
- Remote branch: `origin/fix/daemon-actor-release-gate`
- Code candidate tested by the completed macOS reruns: `77cbc91b`
- Later commit `443007fa` only records the macOS manual results.
- This handoff is also documentation-only.

Use `77cbc91b` for the Windows test run so Windows exercises exactly the code
already exercised by the macOS reruns. Read this handoff from the branch first,
then detach at the candidate while testing. Return to the branch before editing
the Windows report.

If any product code changes during Windows remediation, that commit becomes a
new candidate. Stop claiming same-candidate release-gate coverage, run the
targeted automated checks, and record which macOS cells must be rerun against
the new candidate.

## What this branch already fixes

- `08df0268`: protects the shared `vt100` parser from height-one wrapping
  panics while preserving the logical grid size.
- `eb4f6ce4`, `85452d46`, `82ec64c5`: persists abnormal actor teardown failure
  metadata before socket cleanup without overwriting a terminal coordinator
  result.
- `1e0a7548`: makes `attention.idleSeconds` user-settable and adds deterministic
  acknowledgement/body-change/re-flag coverage.
- `01d13d3d`: characterizes macOS `PENDIN` without weakening functional terminal
  restoration criteria.
- `9f812865`: corrects overstated or blocked result classifications.
- `77cbc91b`: treats forwarded controller input as real program activity even
  during the browser resize-settle window, in both actor and legacy engines.
- `443007fa`: records successful targeted macOS reruns.

## Required Windows environment

Use a physical or virtual Windows x64 desktop with all of the following:

- Windows Terminal, launched interactively. Do not use a non-interactive agent
  process, redirected stdin/stdout, SSH-only shell, or pseudo-console test
  server for attached-terminal assertions.
- PowerShell 7 (`pwsh`) in Windows Terminal.
- Git.
- Rust and Cargo for the repository's pinned toolchain.
- Visual Studio 2022 C++ Build Tools with the Desktop development with C++
  workload and a Windows SDK.
- Bun `1.3.14` or newer.
- Microsoft Edge or Google Chrome.
- The climon dashboard installed as a PWA from the local server.
- `vim` and GitHub Copilot CLI available for the full-screen/frame-caching TUI
  checks. Install them before classifying DAR-01 or DAR-04.

Record the environment:

```powershell
Get-ComputerInfo |
  Select-Object WindowsProductName, WindowsVersion, OsBuildNumber, OsArchitecture
pwsh --version
git --version
rustc --version
cargo --version
bun --version
copilot --version
vim --version | Select-Object -First 3
```

If a real interactive console or installed PWA is unavailable, stop. The prior
Windows run already established that a non-interactive host cannot resolve the
blocked cells.

## Checkout and build

Clone the repository if necessary, then use the existing branch. Do not create
another worktree on the Windows machine unless the checkout already contains
unrelated work.

```powershell
git fetch origin
git switch fix/daemon-actor-release-gate
git pull --ff-only origin fix/daemon-actor-release-gate
git status --short
git log -1 --oneline
```

`git status --short` must be empty. Open and read this handoff, then pin the test
checkout:

```powershell
git switch --detach 77cbc91b
git rev-parse HEAD
git status --short
```

Expected candidate: `77cbc91b...`, with a clean worktree.

Install and build the exact checkout:

```powershell
bun install
bun run build:web
Push-Location rust
cargo build --release -p climon-cli
Pop-Location
```

Use the branch-built client throughout:

```powershell
$Climon = (Resolve-Path .\rust\target\release\climon.exe).Path
& $Climon --version
```

Do not substitute a globally installed `climon.exe`.

## Isolated state and dashboard/PWA

Use a fresh `CLIMON_HOME` outside the repository:

```powershell
$Candidate = "77cbc91b"
$env:CLIMON_HOME = Join-Path $env:TEMP "climon-dar-windows-$Candidate"
New-Item -ItemType Directory -Force $env:CLIMON_HOME | Out-Null
$env:CLIMON_SESSION_ENGINE = "actor"
```

If that directory already contains a previous run, choose a new suffix rather
than deleting evidence.

Start the server from the same PowerShell so it inherits `CLIMON_HOME`:

```powershell
$ServerOut = Join-Path $env:CLIMON_HOME "server.stdout.log"
$ServerErr = Join-Path $env:CLIMON_HOME "server.stderr.log"
$Server = Start-Process bun `
  -ArgumentList @("src/server.ts", "server", "--port", "3131") `
  -PassThru `
  -RedirectStandardOutput $ServerOut `
  -RedirectStandardError $ServerErr
Start-Sleep -Seconds 2
Invoke-RestMethod http://127.0.0.1:3131/health
```

Open `http://127.0.0.1:3131/` in Edge or Chrome and install it as a PWA using
the browser's install-app control. Keep both a normal browser window and the
installed PWA available for DAR-03 and DAR-08.

At the end of the run, stop only the server process captured above:

```powershell
Stop-Process -Id $Server.Id
```

## Evidence helpers

Define these helpers once:

```powershell
function Get-SessionMetadata {
  param([Parameter(Mandatory)][string]$Id)
  Get-Content -Raw (Join-Path $env:CLIMON_HOME "sessions\$Id.json") |
    ConvertFrom-Json
}

function Get-LatestSessionMetadata {
  $file = Get-ChildItem (Join-Path $env:CLIMON_HOME "sessions\*.json") |
    Sort-Object LastWriteTime |
    Select-Object -Last 1
  Get-Content -Raw $file.FullName | ConvertFrom-Json
}

function Get-SessionHost {
  param([Parameter(Mandatory)][string]$Id)
  $escaped = [regex]::Escape($Id)
  @(Get-CimInstance Win32_Process -Filter "Name = 'climon.exe'" |
    Where-Object { $_.CommandLine -match "__session\s+$escaped(?:\s|$)" })
}

function Show-SessionEvidence {
  param([Parameter(Mandatory)][string]$Id)
  $sessionDir = Join-Path $env:CLIMON_HOME "sessions"
  $metadata = Get-SessionMetadata $Id
  $metadata | ConvertTo-Json -Depth 10
  Get-Item (Join-Path $sessionDir "$Id.json") -ErrorAction SilentlyContinue
  Get-Item (Join-Path $sessionDir "$Id.scrollback") -ErrorAction SilentlyContinue
  Get-Item (Join-Path $sessionDir "$Id.log") -ErrorAction SilentlyContinue
  Get-Item (Join-Path $env:CLIMON_HOME "logs\daemon\$Id.log") `
    -ErrorAction SilentlyContinue
  Get-SessionHost $Id | Select-Object ProcessId, ParentProcessId, CommandLine
}

function Show-TcpListener {
  param([Parameter(Mandatory)][string]$SocketPath)
  if ($SocketPath -match '^tcp://[^:]+:(\d+)$') {
    Get-NetTCPConnection -State Listen -LocalPort ([int]$Matches[1]) `
      -ErrorAction SilentlyContinue
  } else {
    Write-Host "Not a loopback-TCP socket reference: $SocketPath"
  }
}
```

For each DAR row, record:

- Exact commit and `climon --version`.
- Windows edition/build and terminal/browser/PWA versions.
- Session ID or IDs.
- Relevant metadata before and after the action.
- Final scrollback contents or tail.
- `sessions/<id>.log` and `logs/daemon/<id>.log`.
- The uniquely resolved `climon __session <id>` host PID when process lifecycle
  is relevant. Never treat metadata `daemonPid` as the host PID; it is the PTY
  child PID.
- Listener state for the metadata `socketPath`.
- Screenshots for browser/PWA rendering, control handoff, title/progress, and
  viewer-isolation assertions.

## Result rules

- **Pass:** every core assertion in the canonical case was directly observed.
- **Fail:** a core assertion was exercised and produced incorrect behavior.
- **Blocked:** the environment or prerequisite prevented a core assertion.
- **Partial:** only when some independent assertions passed and another
  independent assertion was not exercised. Do not use Partial to soften a
  reproduced failure.

The canonical procedures and expected results remain:
`docs/manual-tests/daemon-actor-rewrite.md`. If this handoff and the canonical
case disagree, stop and resolve the documentation conflict before testing.

## Ordered Windows matrix

Run the rows in order. Keep `$env:CLIMON_SESSION_ENGINE = "actor"` unless a
legacy control is explicitly required.

### DAR-01 — Attached interactive fidelity and console restoration

1. In a real Windows Terminal tab:

   ```powershell
   $env:CLIMON_SESSION_ENGINE = "actor"
   & $Climon shell
   ```

2. In the managed shell, run commands, type/edit Unicode text, use Backspace and
   arrow-key history, then launch `vim`.
3. Exercise insert mode, cursor movement, screen redraw, save/quit, then exit
   the managed shell.
4. In the original PowerShell, verify local echo, line editing, Ctrl-C, arrow
   history, and Unicode input still work.
5. Repeat with legacy in a fresh tab if actor input/output is blank, hangs, or
   corrupt:

   ```powershell
   $env:CLIMON_SESSION_ENGINE = "legacy"
   & $Climon shell
   ```

Pass only if actor input, output, the full-screen TUI, UTF-16-to-UTF-8 input,
and post-exit console restoration all work. A shared actor/legacy failure still
blocks the release gate but must not be described as actor-specific.

### DAR-02 — Headless attach, replay, and live output

Start a paced headless actor session:

```powershell
$env:CLIMON_SESSION_ENGINE = "actor"
& $Climon run --headless powershell.exe -NoProfile -Command `
  '1..100 | ForEach-Object { "DAR02 line $_"; Start-Sleep -Milliseconds 200 }'
$Dar02 = (Get-LatestSessionMetadata).id
$Dar02
```

Confirm the captured ID matches the printed session ID, `climon ls` reports it
running, and its daemon log exists. Wait until at least 20 lines have been
produced, then open the session in the dashboard. The first render must replay
the earlier lines and subsequent lines must arrive live. Close the dashboard
temporarily and confirm the command continues.

After completion:

```powershell
Show-SessionEvidence $Dar02
Get-Content (Join-Path $env:CLIMON_HOME "sessions\$Dar02.scrollback") |
  Select-Object -Last 20
```

If output is blank or the child does not exit, repeat the same command with
`legacy` before assigning blame.

### DAR-03 — Browser/PWA control and local Space reclaim

1. Start an attached actor shell from Windows Terminal.
2. Open it in the normal browser and take control.
3. Confirm the local terminal is displaced behind the dashboard notice and all
   local keys except Space are swallowed.
4. Open the same session in the installed PWA and take control there. Confirm
   the newest surface wins and the previous controller is displaced.
5. Press Space in Windows Terminal. Confirm local control returns and the screen
   repaints immediately.
6. With local control active, resize the Windows Terminal window. In a
   full-screen TUI, confirm the PTY follows the real console viewport and
   reflows within the 200 ms polling cadence.

Capture screenshots of browser control, PWA control, and the local displaced
notice. Repeat with legacy if browser control, Space reclaim, or local resize
fails.

### DAR-04 — Restore and same-size repaint jiggle

Perform both independent subcases:

1. Run `vim` in an attached actor session. Take browser control at a larger
   viewport, then press Space locally. The restored local screen must repaint
   fully without stale or half-painted regions.
2. Run the frame-caching TUI:

   ```powershell
   $env:CLIMON_SESSION_ENGINE = "actor"
   & $Climon run copilot
   ```

   Set the browser terminal grid to the same rows and columns as the PTY before
   taking control. Take control without a user-visible resize. Confirm Copilot
   repaints its authoritative frame. A brief one-column/one-row flicker is
   acceptable; a stale frame is not.

`vim` alone is insufficient for the second assertion. Record actor and legacy
controls if either restore path fails.

### DAR-05 — Attention, acknowledgement, body change, and resize stickiness

Use a short global idle interval:

```powershell
& $Climon config --global attention.idleSeconds 3
& $Climon config --global attention.idleSeconds
$env:CLIMON_SESSION_ENGINE = "actor"
& $Climon shell
```

With the dashboard viewer open:

1. Leave the prompt unchanged for at least three seconds and confirm
   `needs-attention` in both the dashboard and `climon ls`.
2. Focus/open the session and confirm durable status `acknowledged`, not
   `running`.
3. Run `Write-Output "DAR-05 changed body"` and leave the line visible. Confirm
   metadata transitions from `acknowledged` to `running`.
4. Wait a complete new interval and confirm a fresh attention episode occurs.
5. While flagged, resize only the browser or local console without producing
   program output. Confirm the attention token/status remains flagged.
6. Acknowledge after the resize and confirm it is accepted.

Save metadata after every transition. If the output/body change during browser
control does not clear acknowledgement, repeat with legacy and inspect the
daemon log for resize-settle classification before changing code.

### DAR-06 — OSC title and progress capture

Start a long-lived actor PowerShell session:

```powershell
$env:CLIMON_SESSION_ENGINE = "actor"
& $Climon shell
```

At the managed PowerShell prompt, emit title and progress:

```powershell
$e = [char]27
$b = [char]7
[Console]::Write("$e]0;dar-title$b")
Start-Sleep -Milliseconds 500
[Console]::Write("$e]2;dar-title-2$b")
Start-Sleep -Milliseconds 500
[Console]::Write("$e]9;4;1;42$b")
```

Confirm the dashboard subtitle and 42% progress indicator, and confirm metadata
contains `terminalTitle` and `progress`. Then clear progress:

```powershell
[Console]::Write("$e]9;4;0;0$b")
Start-Sleep -Milliseconds 500
```

Confirm the indicator and persisted progress clear while the terminal bytes
still reach the attached client. Repeat with legacy if actor output is blank,
the command does not exit, or OSC bytes are not visible/persisted; the previous
Windows environment had shared ConPTY symptoms and did not isolate this row.

### DAR-07 — Fast/failed exit, final scrollback, and listener cleanup

Run both cases with actor:

```powershell
$env:CLIMON_SESSION_ENGINE = "actor"
& $Climon run --headless cmd.exe /d /c "echo done & exit /b 0"
$Success = (Get-LatestSessionMetadata).id
& $Climon run --headless cmd.exe /d /c "echo boom & exit /b 7"
$Failure = (Get-LatestSessionMetadata).id
Start-Sleep -Seconds 3
```

For each ID, inspect metadata, final scrollback, daemon log, host process, and
listener:

```powershell
foreach ($Id in @($Success, $Failure)) {
  Show-SessionEvidence $Id
  $m = Get-SessionMetadata $Id
  Get-Content (Join-Path $env:CLIMON_HOME "sessions\$Id.scrollback")
  Show-TcpListener $m.socketPath
}
```

The success case must contain `done`, status `completed`, exit code `0`, and
`completedAt`. The failure case must contain `boom`, status `failed`, exit code
`7`, and `completedAt`. Neither host may remain, and neither TCP listener may
remain.

If either session stays running or loses early output, repeat both commands
with `legacy`. Record whether the symptom is actor-only or shared before
debugging.

### DAR-08 — Slow/disconnecting viewer isolation

Use an attached, paced stream so the local console and both viewers can be
observed:

```powershell
$env:CLIMON_SESSION_ENGINE = "actor"
& $Climon run powershell.exe -NoProfile -Command `
  '1..3000 | ForEach-Object { "DAR08 line $_"; Start-Sleep -Milliseconds 5 }'
```

While it runs:

1. Open the session in both the normal browser and installed PWA.
2. Confirm both surfaces and the local terminal receive live output.
3. In one browser surface, use DevTools network throttling or close the window
   abruptly.
4. Confirm the healthy viewer and local terminal continue advancing without a
   pause or daemon exit.
5. After completion, confirm metadata is terminal with exit code `0` and final
   scrollback contains `DAR08 line 3000`.
6. Inspect the daemon log for a single disconnect/send-failure outcome for the
   affected viewer and no panic.

Capture the completed session and evidence:

```powershell
$Dar08 = (Get-LatestSessionMetadata).id
Show-SessionEvidence $Dar08
Get-Content (Join-Path $env:CLIMON_HOME "sessions\$Dar08.scrollback") |
  Select-Object -Last 20
```

If output never streams or the command does not exit, run the same paced command
with legacy. Do not classify viewer isolation from tabs that merely remained
open; the healthy viewer must visibly advance after the other viewer is
throttled or disconnected.

### DAR-09 — Forced host termination and console resize poller

This Windows row has two independent subcases.

**Resize poller:** in an attached actor session running `vim`, resize Windows
Terminal several times and pause between changes. Confirm the app reflows on
real size changes and does not continuously redraw while the size is stable.

**Forced host termination:** start a headless long-lived actor session:

```powershell
$env:CLIMON_SESSION_ENGINE = "actor"
& $Climon run --headless powershell.exe -NoProfile -Command 'Start-Sleep 300'
$Dar09 = (Get-LatestSessionMetadata).id
$Hosts = @(Get-SessionHost $Dar09)
$Hosts | Select-Object ProcessId, ParentProcessId, CommandLine
```

There must be exactly one verified `climon __session $Dar09` host:

```powershell
if ($Hosts.Count -ne 1) {
  throw "Expected exactly one daemon host for $Dar09; found $($Hosts.Count)"
}
Stop-Process -Id $Hosts[0].ProcessId -Force
```

This is forced `TerminateProcess`, not graceful shutdown. It is expected that
ordered finalization does not run and on-disk metadata may remain `running`.
Confirm the dashboard liveness probe marks the dead session disconnected, then
reconcile it:

```powershell
& $Climon kill $Dar09
```

Confirm the stale record is marked failed/removed as documented. Do not report
the expected lack of graceful forced-kill cleanup as a defect. DAR-07, not this
forced-kill path, is the Windows graceful teardown assertion.

### DAR-10 — Actor/legacy selector and rollback

Run equivalent fast and attached commands under all selector states:

```powershell
Remove-Item Env:\CLIMON_SESSION_ENGINE -ErrorAction SilentlyContinue
& $Climon run cmd.exe /d /c "echo default-legacy"

$env:CLIMON_SESSION_ENGINE = "actor"
& $Climon run cmd.exe /d /c "echo explicit-actor"

$env:CLIMON_SESSION_ENGINE = "legacy"
& $Climon run cmd.exe /d /c "echo explicit-legacy"
```

Confirm I/O, status, exit code, scrollback, and attached shell behavior are
externally equivalent, with unset/default and explicit legacy selecting the
rollback engine without rebuilding.

Test invalid selection in both attached and headless forms:

```powershell
$env:CLIMON_SESSION_ENGINE = "future"
& $Climon run cmd.exe /d /c "echo must-not-run"
& $Climon run --headless cmd.exe /d /c "echo must-not-run"
$Invalid = (Get-LatestSessionMetadata).id
Get-Content (Join-Path $env:CLIMON_HOME "sessions\$Invalid.log")
Get-Item (Join-Path $env:CLIMON_HOME "logs\daemon\$Invalid.log") `
  -ErrorAction SilentlyContinue
```

The attached invocation must surface the invalid-engine error. The headless
host must exit before daemon logger initialization, write the error to
`sessions/<id>.log`, create no `logs/daemon/<id>.log`, and never run the child.

Restore actor selection before any rerun:

```powershell
$env:CLIMON_SESSION_ENGINE = "actor"
```

## Stop and debug rules

Stop the matrix immediately when a core assertion fails. Preserve
`CLIMON_HOME`, screenshots, logs, metadata, scrollback, and the exact commands.

Before changing production code:

1. Reproduce the smallest failing actor case.
2. Run the same case with `CLIMON_SESSION_ENGINE=legacy`.
3. Return from the detached candidate to the branch before editing:

   ```powershell
   git switch fix/daemon-actor-release-gate
   git pull --ff-only origin fix/daemon-actor-release-gate
   git status --short
   ```

   The status must be clean. Preserve runtime evidence under the external
   `CLIMON_HOME`; do not copy generated state into the repository.
4. Decide whether the failure is actor-only, shared session code, Windows
   console/ConPTY code, dashboard code, or an environmental limitation.
5. Read the relevant implementation and existing tests.
6. Add the smallest deterministic regression test that fails for the observed
   reason.
7. Run that test and capture the expected failure.
8. Implement the minimal root-cause fix. Do not add broad catches, sleeps as a
   correctness mechanism, or success-shaped fallbacks.
9. Run the new test, its surrounding test module/crate, and the corresponding
   actor/legacy manual control.
10. Commit the focused fix before moving to another defect.

Likely code areas:

- Windows console mode/input/resize:
  `rust/climon-session/src/adapters/local_terminal.rs`,
  `rust/climon-session/src/adapters/signals.rs`
- Windows ConPTY lifecycle: `rust/climon-pty/`
- Actor lifecycle/teardown:
  `rust/climon-session/src/engine/supervisor.rs`,
  `rust/climon-session/src/engine/coordinator.rs`
- Actor input/control:
  `rust/climon-session/src/engine/state.rs`,
  `rust/climon-session/src/adapters/ipc.rs`
- Legacy controls: `rust/climon-session/src/host/legacy.rs`
- Shared attention/fingerprint:
  `rust/climon-session/src/idle.rs`,
  `rust/climon-session/src/domain/attention.rs`,
  `rust/climon-session/src/fingerprint.rs`
- Dashboard bridge/UI: `src/server/`, `src/web/`

If product code changes, test the new commit rather than continuing to append
results for `77cbc91b`. Clearly mark earlier rows as superseded or rerun them on
the new candidate.

## Automated checks after the manual matrix

With the final candidate checked out, run:

```powershell
Push-Location rust
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
cargo build --release -p climon-cli
Pop-Location

bun run typecheck
bun test tests/config-settings.test.ts tests/config-fixtures.test.ts
```

If a command fails, fix only failures caused by this branch. Record unrelated
baseline/environment failures exactly rather than masking them.

## Update the Windows report

Return to the branch after testing:

```powershell
git switch fix/daemon-actor-release-gate
git pull --ff-only origin fix/daemon-actor-release-gate
git status --short
```

Update:

`docs/manual-tests/results/windows.md`

Replace the old environment description and all ten rows with the real-console
run. Include:

- Exact tested commit, including an explicit note if branch HEAD contains only
  documentation commits beyond tested code candidate `77cbc91b`.
- Tester, Windows build/architecture, Windows Terminal, browser, and PWA.
- Actor and legacy controls for any shared blank-output, non-exit, control,
  ConPTY, or lifecycle symptom.
- Session IDs and concise references to preserved evidence.
- One of Pass, Fail, Blocked, or Partial under the rules above.
- An updated release-gate statement.

Do not mark Windows passed unless all ten rows' core assertions were directly
exercised and passed. Do not flip the default actor selector.

## Commit and push

Review the diff:

```powershell
git diff --check
git diff -- docs/manual-tests/results/windows.md
git status --short
```

Commit the Windows report and any focused fixes. Include the repository's
required Copilot trailers in every commit. The Windows Copilot CLI session must
append its own current `Co-authored-by` and `Copilot-Session` trailers; do not
reuse the macOS session ID. For a report-only commit:

```powershell
git add docs/manual-tests/results/windows.md
git commit -m "docs: record Windows daemon actor rerun"
git push origin fix/daemon-actor-release-gate
```

Use the actual Windows Copilot session ID in that commit trailer. Do not merge
the branch and do not open a release PR.

## Finish with the Linux handoff

After Windows results and any fixes are pushed, create a new self-contained
Linux handoff on this branch. Pin it to the final Windows candidate, require a
real Linux terminal and browser/PWA coverage, rerun all `DAR-01` through
`DAR-10` rows, and explicitly close the existing Linux DAR-04 frame-caching and
DAR-09 direct SIGWINCH coverage gaps.
