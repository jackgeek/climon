# Windows manual-test results

Results for the Windows cell of
[`daemon-actor-rewrite.md`](../daemon-actor-rewrite.md), executed on
2026-07-19 from commit `e2459408` (`design/idiomatic-daemon-rewrite`) with the
branch-built `climon v3.2.0` release binary.

The execution environment was a non-interactive Windows CLI host. Browser
coverage was added with Playwright MCP against the dashboard at
`http://127.0.0.1:3131/`, and direct process I/O was attempted with
`pty-mcp-server`. The PTY server's Windows `agent-proc-*` transport does not
provide the real interactive console required by the attached-terminal cases;
there was no installed PWA.

| ID | Date | Tester | Platform | Version | Result | Notes |
|---|---|---|---|---|---|---|
| DAR-01 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | `pty-mcp-server` launched `climon shell` and accepted an `echo DAR01_INPUT_OK` write, but returned no terminal output and supplied no real Windows console. Attached input fidelity, a full-screen TUI, and console-mode restoration remain unverified. |
| DAR-02 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Partial pass | Playwright navigated to the dashboard successfully. The completed `warm-kiwis-poke` actor session was visible with replayed output through line 60. A fresh mid-stream `healthy-carpets-crash` actor daemon was reported running and opened in the dashboard, but its full-screen terminal rendered blank and the child remained alive after its command should have exited. Replay plus continued live output was therefore not re-verified end to end. |
| DAR-03 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | Browser terminal surfaces can now be opened, but the PTY transport still cannot provide the attached Windows console needed to verify local displacement, Space reclaim, and local-size authority. No PWA surface was available. |
| DAR-04 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | Requires an attached full-screen TUI and browser to observe restore and same-size repaint jiggles. |
| DAR-05 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Partial pass | A fresh actor session reached `needs-attention` after 10 seconds; selecting it in the dashboard changed persisted status to `acknowledged`. Resize stickiness while flagged could not be exercised because selecting the browser viewer acknowledged immediately and no real local console was available. |
| DAR-06 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Fail | A PowerShell actor session emitted OSC 0 title `dar-title` and OSC 9;4 determinate progress `42`, then stayed alive for observation. Persisted metadata never gained `terminalTitle` or `progress`, and the dashboard continued to show the command with no title/progress rendering. |
| DAR-07 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | Fresh headless `cmd.exe` fast-success and exit-7 sessions both remained `running` five seconds after `exit /b`, so final scrollback, terminal metadata, exact exit codes, and listener release could not be checked. The same non-exit behavior previously reproduced with the legacy engine in this host, so no actor-specific failure is claimed. |
| DAR-08 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Partial pass | Playwright opened the same actor session in two browser pages; closing one page left the other terminal surface open and the detached host alive. The high-volume command was not visibly streaming and its activity timestamp stayed static, so isolation under outbound backpressure remains unverified. |
| DAR-09 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Partial pass | The detached host was resolved uniquely by its `__session <id>` command line and force-terminated by PID. Metadata remained `running`, no final scrollback was written, and `climon kill <id>` removed the stale metadata, matching the documented forced-termination behavior. Console resize polling remains blocked because no interactive console was available. |
| DAR-10 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Partial pass | Invalid `future` selection failed with the exact expected message. Attached execution returned exit code 1; headless execution wrote the error to `sessions/<id>.log`, created no daemon log, and exited. Actor/legacy interactive I/O equivalence remains blocked by the non-interactive ConPTY environment. |

## Release-gate status

The Windows release gate is **not passed**. DAR-06 produced a failing
title/progress result; DAR-02, DAR-05, DAR-08, DAR-09, and DAR-10 are only
partially exercised; and the remaining attached-console cases are blocked.
Re-run the matrix from a real interactive Windows console, including the PWA
surface, before changing the actor engine from opt-in to default.
