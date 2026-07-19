# Windows manual-test results

Results for the Windows cell of
[`daemon-actor-rewrite.md`](../daemon-actor-rewrite.md), executed on
2026-07-19 from commit `e2459408` (`design/idiomatic-daemon-rewrite`) with the
branch-built `climon v3.2.0` release binary.

The execution environment was a non-interactive Windows CLI host without an
interactive console, browser, or installed PWA. Cases requiring those surfaces
remain blocked and must not be treated as passed.

| ID | Date | Tester | Platform | Version | Result | Notes |
|---|---|---|---|---|---|---|
| DAR-01 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | Requires a real interactive console to exercise attached input, full-screen TUI rendering, and console-mode restoration. |
| DAR-02 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | The headless actor daemon started, metadata used loopback TCP, `climon ls` reported it running, and the daemon log was created. Dashboard replay/live-output observation was unavailable. The prescribed ConPTY command did not exit in this non-interactive host; a legacy-engine control behaved the same, so this is not evidence of an actor regression. |
| DAR-03 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | Requires an attached console plus browser/PWA surfaces to verify take-control, displacement, Space reclaim, and controller-driven resize. |
| DAR-04 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | Requires an attached full-screen TUI and browser to observe restore and same-size repaint jiggles. |
| DAR-05 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | A headless actor session reached `needs-attention` after the configured idle interval, but dashboard acknowledgement and resize-stickiness require interactive viewer surfaces and were not exercised. |
| DAR-06 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | The OSC-emitting PowerShell process launched, but title/progress metadata and dashboard rendering were not observed in this non-interactive ConPTY host. |
| DAR-07 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | The prescribed fast-exit `cmd` process remained alive under ConPTY, preventing valid finalization checks. The same behavior reproduced with the legacy engine in this host, so no actor-specific failure is claimed. |
| DAR-08 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | Requires an attached terminal and two browser viewers, including one throttled or disconnected viewer. |
| DAR-09 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Partial pass | The detached host was resolved uniquely by its `__session <id>` command line and force-terminated by PID. Metadata remained `running`, no final scrollback was written, and `climon kill <id>` removed the stale metadata, matching the documented forced-termination behavior. Console resize polling remains blocked because no interactive console was available. |
| DAR-10 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Partial pass | Invalid `future` selection failed with the exact expected message. Attached execution returned exit code 1; headless execution wrote the error to `sessions/<id>.log`, created no daemon log, and exited. Actor/legacy interactive I/O equivalence remains blocked by the non-interactive ConPTY environment. |

## Release-gate status

The Windows release gate is **not passed**. DAR-01 through DAR-08 remain blocked,
and DAR-09 and DAR-10 are only partially exercised. Re-run the matrix from a
real interactive Windows console with the dashboard and PWA available before
changing the actor engine from opt-in to default.
