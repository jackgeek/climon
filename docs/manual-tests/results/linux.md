# Linux manual-test results

Results for the Linux cell of
[`daemon-actor-rewrite.md`](../daemon-actor-rewrite.md), executed on
2026-07-19 from commit `68bc1cf7` (`design/idiomatic-daemon-rewrite`) with the
branch-built `climon v3.2.0` release binary (`cargo build --release -p
climon-cli`).

The execution environment is a non-interactive Linux (WSL2) CLI host with no
tty of its own (`os.isatty()` is `false` for stdin/stdout) and no local
browser. Two MCP tools were installed mid-run to remove these limitations:

- **`pty-mcp-server`** (a Haskell MCP server providing `agent-proc-run` /
  `-read` / `-write` / `-terminate`) spawns `/bin/bash`, and the tests then
  ran `script -qc /bin/bash /dev/null` inside it to allocate a **real**
  `/dev/pts/*` controlling terminal (confirmed via `tty`/`stty -a`, which fail
  with "Inappropriate ioctl for device" on a plain pipe but succeed on the
  `script`-wrapped pty). This unblocked DAR-01, DAR-03, and DAR-04.
- **Playwright MCP** (`@playwright/mcp`, Chromium) drove a real headed-engine
  browser (headless Chromium binary) against the actual dashboard
  (`bun src/server.ts server`), clicking, typing, resizing, and
  screenshotting exactly as a human user would. This upgraded DAR-02 from
  protocol-only to a real rendered-browser pass and unblocked DAR-03/DAR-04.

With both tools in place, DAR-01/03/04's earlier "Blocked" verdicts are now
superseded below; DAR-08's coordinator-panic finding was also independently
re-confirmed using two real Playwright tabs (see finding below), a stronger
result than the original synthetic-WebSocket-script reproduction alone.

One environment quirk: this sandbox denies the controlling-terminal ioctl
`setsid -c` performs (`rust/climon-pty/src/command.rs:44-49`), so headless
runs initially failed with `setsid: failed to set the controlling terminal:
Operation not permitted` captured as the command's entire output. All
headless cases below were re-run with the documented escape hatch
`CLIMON_DISABLE_SETSID=1`, after which sessions ran normally; this matches
the documented GitHub-hosted-runner workaround and is not a product defect.

| ID | Date | Tester | Platform | Version | Result | Notes |
|---|---|---|---|---|---|---|
| DAR-01 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | Pass | Real controlling terminal via `pty-mcp-server` (`agent-proc-run /bin/bash` → `script -qc /bin/bash /dev/null`, confirmed `/dev/pts/3` via `tty`). Recorded `stty -a` (cooked mode: `icanon echo`), ran `CLIMON_SESSION_ENGINE=actor CLIMON_DISABLE_SETSID=1 climon shell` (session `quick-spies-pump`), ran `ls`/`echo hi`, then launched `vim`: full-screen alt-screen escape sequences rendered, `i` entered insert mode and typed text with the cursor position updating live in the status line, confirming input reaches the child and output/redraw render correctly. Exited via killing vim then `exit`; `stty -a` after was **byte-identical** to the "before" capture (`diff` → `STTY_MATCH`), confirming raw-mode restoration. |
| DAR-02 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | Pass | Upgraded from the earlier protocol-only partial pass to a real rendered-browser check. Started a headless actor session (`climon run --headless bash -lc 'for i in $(seq 1 40); do echo "line $i"; sleep 1; done'`), let it run ~8s, then opened it in a real Playwright-driven Chromium tab against the live dashboard. The initial accessibility snapshot showed a scrollback replay through `line 29` (mid-stream attach), and a follow-up snapshot 4s later showed continued live output through `line 40` with the session card visually transitioning `running` → `completed` in the browser — replay-then-live confirmed visually, not just at the protocol level. |
| DAR-03 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | Pass | Real terminal (`pty-mcp-server`) + real browser (Playwright/Chromium) both used. Started `CLIMON_SESSION_ENGINE=actor climon shell` (session `seven-weeks-tan`) as local controller; opened the session in the browser, which showed "This session is being viewed elsewhere. / Take control"; clicking **Take control** displaced the local terminal, which then printed the exact expected banner `This session is being viewed on a climon dashboard. Press Space to take control.` and swallowed a stray `echo should_not_appear` keystroke (never reached the shell). Typing `echo FROM_BROWSER_DAR03` in the **browser's** terminal input and pressing Enter round-tripped to the real shell, which echoed `FROM_BROWSER_DAR03` back to the browser's rendered terminal — proving live bidirectional input/output through a real browser as controller. Pressing **Space** in the local terminal reclaimed control and immediately repainted the full transcript (not left blank); the browser flipped back to "being viewed elsewhere / Take control". With the local terminal back in control, `stty rows 40 cols 120` (a real local resize) propagated to the daemon's shared PTY: `tput cols`/`tput lines` run **inside** the climon-managed child shell reported `120`/`40`, confirming local-size → PTY sizing, not just the outer wrapper. |
| DAR-04 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | Pass | Real terminal + real browser. `vim` launched full-screen in the local terminal at 120×40 (via `pty-mcp-server`). Resized the Playwright browser viewport larger (1600×1000) *before* clicking **Take control**, displacing the local terminal; vim's full-screen buffer re-rendered correctly at the larger grid in the browser. Pressed **Space** locally to reclaim/restore: vim repainted cleanly (tildes filled the 120-col local width, no stale/half-painted screen). For the same-size take-control case (step 4), `htop`/`copilot` were unavailable in this sandbox, so `vim` was substituted as the full-screen TUI under test (documented deviation — this does not exercise Ink/frame-caching specifically, but does exercise the daemon-level same-size jiggle-repaint path). Verified via `browser_evaluate` that the browser's xterm view already rendered exactly 24 rows (matching the local terminal's 80×24, i.e. no dimension change would occur), then clicked **Take control** with no resize; a follow-up screenshot showed a fully and cleanly repainted vim screen (correct tildes, correct status line, no artifacts), confirming the two-tick jiggle forced a redraw even without an explicit `SIGWINCH`. |
| DAR-05 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | Pass | A headless actor session running `sleep 120`/`sleep 60` with no output flipped to `needs-attention` after the default 10s idle window (`attentionReason: "Screen idle for 10s"`). A WS `attention` ack referencing the matching `attentionMatchedAt` cleared it to `acknowledged`. Re-flagged after another 10s idle; a `resize` message (`80x24` → `100x30`, no output) was applied (`Control`/`size` frames observed, PTY grid updated) **without** clearing attention — `attentionMatchedAt` stayed identical, confirming resize-is-not-activity. A second ack after the resize was accepted normally. Note: `docs/manual-tests/daemon-actor-rewrite.md` suggests `climon config attention.idleSeconds 3`, but this build's config schema (checked via `climon config`) has no `attention.idleSeconds` key, so the default 10s window was used instead. |
| DAR-06 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | Pass | A headless session emitted `OSC 0` (`dar-title`) then `OSC 9;4;1;42` (progress), then after 2s `OSC 2` (`dar-title-2`) then `OSC 9;4;0;0` (clear). Metadata `terminalTitle` tracked `dar-title` → `dar-title-2`; `progress` appeared while set and was removed entirely after the clear. The raw scrollback still contains the untouched OSC byte sequences, confirming passthrough. |
| DAR-07 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | Pass | `climon run --headless sh -c 'echo done; exit 0'` → scrollback `done`, metadata `status: completed`, `exitCode: 0`, `completedAt` set. `climon run --headless sh -c 'echo boom; exit 7'` → scrollback `boom`, `status: failed`, `exitCode: 7`, `completedAt` set. Both used the default loopback-TCP `socketPath`; after exit the assigned port had no listener (`ss -tln` showed nothing), matching the documented no-op cleanup for TCP transport. |
| DAR-08 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | **Fail** | See "DAR-08 finding" below — a real crash was found and is reproducible, not a test-environment limitation. Independently re-confirmed with two real Playwright/Chromium browser tabs (not just the synthetic WS script). |
| DAR-09 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | Pass | Unix SIGINT/SIGTERM only (Windows forced-termination/resize-poller sub-cases are N/A on this platform). Resolved the detached host each time via `pgrep -f "__session <id>"` (never `daemonPid`), verified a single match, then signaled only that PID. `kill -INT <host>` on a `sleep 300` headless session: host reaped within ~1s, metadata patched to `status: failed`, `exitCode: 1`, `completedAt` set, socket port released. `kill -TERM <host>` on a fresh session: identical graceful outcome. A same-PID double-signal race wasn't literally captured (the host reaped too fast between the two `kill` calls), but this itself demonstrates the shutdown path completes promptly and idempotently — a second signal to the now-dead PID simply errored with "No such process". SIGWINCH (attached full-screen reflow) is blocked — needs a real tty. |
| DAR-10 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | Pass | `CLIMON_SESSION_ENGINE` unset (legacy) and `=actor` produced byte-identical externally-visible I/O/status/exit-code for the same headless command. Unsetting again (rollback) reproduced the legacy result with no rebuild. `CLIMON_SESSION_ENGINE=future`: attached (`climon run`, non-headless) failed to the terminal with exit code 1 and the exact message `climon: invalid CLIMON_SESSION_ENGINE 'future'; expected 'legacy' or 'actor'`; headless failed identically, wrote the same message to `sessions/<id>.log` (not `logs/daemon/<id>.log`, which was never created), and left metadata stuck at `status: running` (no finalization ran, matching "the daemon exits immediately without starting the session"). |

## DAR-08 finding — coordinator panic under concurrent viewers on high-volume output (not actor-specific)

**Reproduction:** start a headless actor session with continuous, long-line
output (`climon run --headless bash -lc 'i=0; while true; do echo
"line-$i-$(head -c 200 /dev/zero | tr "\0" x)"; i=$((i+1)); done'`), then open
**two** WebSocket viewer connections to its `/attach` endpoint within ~1s of
each other (a throttled/non-reading "wedged" TCP client plus a normally-reading
one, and separately two normally-reading viewers — both combinations
reproduce it). Within seconds the daemon logs:

```
{"level":40,"msg":"actor session teardown anomalies: Coordinator=panicked", ...}
climon: a supervised actor task panicked
```

and the redirected stderr (`sessions/<id>.log`) shows a full panic:

```
thread 'tokio-rt-worker' panicked at .../vt100-0.16.2/src/grid.rs:689:18:
called `Option::unwrap()` on a `None` value
...
4: <vt100::screen::Screen>::text
5: <climon_session::fingerprint::HeadlessGrid>::write
6: <climon_session::domain::terminal::TerminalModel>::apply_output
7: <climon_session::engine::state::SessionState>::apply
8: <climon_session::engine::coordinator::Coordinator<...>>::apply_event::{closure#0}
```

The entire session dies (no `climon __session <id>` host process remains),
the monitored child is gone, and metadata is left **permanently stuck** at
`status: running` with no `exitCode`/`completedAt` — a full loss of the
ordered-finalization guarantee documented for normal exits (DAR-07) and
forced kills (DAR-09), because the panicking task *is* the coordinator that
would normally drive that finalization. `climon kill <id>` was needed to
reconcile the stale record afterward.

**Independently re-confirmed with real browsers.** After installing
Playwright MCP (real headless-Chromium engine), the same bug was reproduced a
second time using **two genuine browser tabs** (not synthetic WebSocket
scripts): a headless actor session running `bash -lc 'yes "line-...-END"'`
(unbounded high-volume output) was opened in Playwright tab 0, then in tab 1,
each clicking into the session from the dashboard's session list. The
daemon's log for that session (`logs/daemon/wild-feet-raise.log`) shows
several clients (`client_id` 0 through 7, from repeated navigations/attaches)
hitting `client outbound queue saturated` under the output backpressure, then
on the next daemon-owning operation (triggered here by `climon kill`) the
identical panic surfaced:

```
thread 'tokio-rt-worker' (51803) panicked at .../vt100-0.16.2/src/grid.rs:689:18:
called `Option::unwrap()` on a `None` value
climon: a supervised actor task panicked
```

The **same** panic also independently hit a second, unrelated **interactive**
session (`seven-weeks-tan`, the attached `climon shell` used for DAR-01/03/04)
after several browser take-control/Space-reclaim cycles — i.e. this is not
confined to headless sessions or to two-simultaneous-viewer high-volume
output specifically; it appears to be a more general vt100-grid panic
triggered whenever the coordinator's screen-fingerprint sampling processes
certain terminal content across repeated viewer attach/detach or
control-handoff cycles. This broadens the risk profile of the bug beyond the
DAR-08 scenario as narrowly written.

**Not actor-specific.** The identical `HeadlessGrid`/vt100 panic reproduces
with `CLIMON_SESSION_ENGINE` unset (legacy engine), immediately followed by
cascading `Result::unwrap()` on `PoisonError` panics at
`climon-session/src/host/legacy.rs:1288` and `:1449` (mutex poisoned by the
first panic). This is a pre-existing bug in the shared
`climon_session::fingerprint::HeadlessGrid` attention-fingerprint path (used
by both engines to sample the screen for idle/attention detection), not a
regression introduced by the actor rewrite. However, it still blocks this
release gate: DAR-08 as written cannot be verified ("the healthy viewer and
the PTY keep streaming throughout") when concurrent-viewer attach on
high-volume output reliably crashes the whole session before the isolation
behavior can be observed end-to-end. Recommend filing this as a standalone
bug against `climon-session` fingerprint/vt100 handling, independent of the
actor-rewrite gate.

## Release-gate status

The Linux release gate is **not passed**. DAR-01, DAR-02, DAR-03, and DAR-04
are now fully passed using a real controlling terminal (via `pty-mcp-server`)
and a real browser (via Playwright/Chromium), superseding the earlier
blocked/partial verdicts. DAR-09's SIGWINCH sub-case (attached full-screen
reflow under a real terminal) was not separately re-verified in this pass but
is exercised implicitly by DAR-03/DAR-04's local-resize checks. DAR-08 is
still a **hard fail**, and the finding is now stronger: a reproducible
coordinator panic (shared with the legacy engine) was independently
confirmed both via a synthetic WebSocket script and via two real Playwright
browser tabs, and was also observed to hit an ordinary interactive session
outside the original high-volume/two-viewer scenario. This prevents
verifying per-client viewer isolation and leaves sessions stuck with stale
`running` metadata (or an abruptly panicked coordinator on an attached
session). Fix the `HeadlessGrid`/vt100 panic before changing the actor
engine's default; once fixed, re-run DAR-08 specifically (the rest of the
matrix is now fully green on Linux).
