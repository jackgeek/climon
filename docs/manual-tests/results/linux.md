# Linux manual-test results

Results for the Linux cell of
[`daemon-actor-rewrite.md`](../daemon-actor-rewrite.md), executed on
2026-07-19 from commit `68bc1cf7` (`design/idiomatic-daemon-rewrite`) with the
branch-built `climon v3.2.0` release binary (`cargo build --release -p
climon-cli`).

The execution environment was a non-interactive Linux (WSL2) CLI host without
a real controlling terminal (`tty` reports `not a tty`; `os.isatty()` is
`false` for stdin/stdout) or a browser/PWA. Cases requiring an attached
interactive console or a real browser surface remain **blocked** and must not
be treated as passed. Headless-daemon cases were exercised directly against
the actor engine (`CLIMON_SESSION_ENGINE=actor`) using `climon run
--headless`, direct metadata/scrollback/log inspection, and a small
protocol-level WebSocket "viewer" script driving the dashboard server's real
attach endpoint (`src/server/server.ts`, `/api/sessions/<id>/attach`) to
stand in for a browser where the test only requires JSON/binary frame
exchange, not visual rendering. This is stronger evidence than "blocked" but
is explicitly **not** a substitute for a real browser/PWA UI check.

One environment quirk: this sandbox denies the controlling-terminal ioctl
`setsid -c` performs (`rust/climon-pty/src/command.rs:44-49`), so headless
runs initially failed with `setsid: failed to set the controlling terminal:
Operation not permitted` captured as the command's entire output. All
headless cases below were re-run with the documented escape hatch
`CLIMON_DISABLE_SETSID=1`, after which sessions ran normally; this matches
the documented GitHub-hosted-runner workaround and is not a product defect.

| ID | Date | Tester | Platform | Version | Result | Notes |
|---|---|---|---|---|---|---|
| DAR-01 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | Blocked | Requires a real interactive console to exercise attached input, raw-mode entry/exit, and a nested full-screen TUI; this host has no tty. |
| DAR-02 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | Partial pass | A headless actor session (`climon run --headless bash -lc 'for i in $(seq 1 100); ...'`) ran detached, `climon ls` showed it `running`, and `logs/daemon/<id>.log` existed. A WebSocket attach opened mid-stream (~7s in) and received a JSON `size` message, a JSON `replay` marker, then a binary scrollback replay burst (already-emitted lines 1–23) followed by continuing live output at the source's ~0.3s/line pace (lines 24–64 over the next ~10s) — matching "replay then live, never missing earlier bytes". No real browser rendering was observed (protocol-level check only). |
| DAR-03 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | Blocked | Requires an attached local terminal (to observe the displaced/blank notice and Space reclaim) plus a real browser/PWA to take control visually. A `Control` frame was incidentally observed on the WS surrogate after a `resize` message during DAR-05/DAR-08, confirming the wire-level control/resize frame fires, but the local-terminal-displacement UI and Space-reclaim flow were not exercised. |
| DAR-04 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | Blocked | Requires an attached full-screen TUI and a real browser to observe the same-size jiggle repaint; no tty or browser available. |
| DAR-05 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | Pass | A headless actor session running `sleep 120`/`sleep 60` with no output flipped to `needs-attention` after the default 10s idle window (`attentionReason: "Screen idle for 10s"`). A WS `attention` ack referencing the matching `attentionMatchedAt` cleared it to `acknowledged`. Re-flagged after another 10s idle; a `resize` message (`80x24` → `100x30`, no output) was applied (`Control`/`size` frames observed, PTY grid updated) **without** clearing attention — `attentionMatchedAt` stayed identical, confirming resize-is-not-activity. A second ack after the resize was accepted normally. Note: `docs/manual-tests/daemon-actor-rewrite.md` suggests `climon config attention.idleSeconds 3`, but this build's config schema (checked via `climon config`) has no `attention.idleSeconds` key, so the default 10s window was used instead. |
| DAR-06 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | Pass | A headless session emitted `OSC 0` (`dar-title`) then `OSC 9;4;1;42` (progress), then after 2s `OSC 2` (`dar-title-2`) then `OSC 9;4;0;0` (clear). Metadata `terminalTitle` tracked `dar-title` → `dar-title-2`; `progress` appeared while set and was removed entirely after the clear. The raw scrollback still contains the untouched OSC byte sequences, confirming passthrough. |
| DAR-07 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | Pass | `climon run --headless sh -c 'echo done; exit 0'` → scrollback `done`, metadata `status: completed`, `exitCode: 0`, `completedAt` set. `climon run --headless sh -c 'echo boom; exit 7'` → scrollback `boom`, `status: failed`, `exitCode: 7`, `completedAt` set. Both used the default loopback-TCP `socketPath`; after exit the assigned port had no listener (`ss -tln` showed nothing), matching the documented no-op cleanup for TCP transport. |
| DAR-08 | 2026-07-19 | Copilot CLI | Linux x64 (WSL2) | 3.2.0 (`68bc1cf7`) | **Fail** | See "DAR-08 finding" below — a real crash was found and is reproducible, not a test-environment limitation. |
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

The Linux release gate is **not passed**. DAR-01, DAR-03, and DAR-04 remain
blocked on this non-interactive, browser-less host. DAR-02 and DAR-09 are
only partially exercised (no real browser/PWA rendering; no attached-terminal
SIGWINCH reflow). DAR-08 is a **hard fail**: a reproducible coordinator panic
(shared with the legacy engine) prevents verifying per-client viewer
isolation and leaves sessions stuck with stale `running` metadata. Fix the
`HeadlessGrid`/vt100 panic and re-run the full matrix — including DAR-01,
DAR-03, DAR-04, and the SIGWINCH sub-case of DAR-09 — from a real interactive
Linux console with the dashboard and a browser/PWA available before changing
the actor engine's default.
