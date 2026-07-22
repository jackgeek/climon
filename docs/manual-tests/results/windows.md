# Windows manual-test results

Results for the Windows cell of
[`daemon-actor-rewrite.md`](../daemon-actor-rewrite.md). The baseline matrix was
executed on 2026-07-19 from commit `e2459408`
(`design/idiomatic-daemon-rewrite`) with the branch-built `climon v3.2.0`
release binary. DAR-03/TCH-14 was rerun on 2026-07-22 from commit `98bb7e1a`.

The baseline execution environment was a non-interactive Windows CLI host.
Browser coverage was added with Playwright MCP, and direct process I/O was
attempted with `pty-mcp-server`. The targeted rerun used a real Windows Terminal
+ OpenConsole surface, the source dashboard at `http://127.0.0.1:3135/`, and
the repository-approved **Menu → Tunnel Link → Open link** PWA simulation.

| ID | Date | Tester | Platform | Version | Result | Notes |
|---|---|---|---|---|---|---|
| DAR-01 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | `pty-mcp-server` launched `climon shell` and accepted an `echo DAR01_INPUT_OK` write, but returned no terminal output and supplied no real Windows console. Attached input fidelity, a full-screen TUI, and console-mode restoration remain unverified. |
| DAR-02 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Partial pass | Playwright navigated to the dashboard successfully. The completed `warm-kiwis-poke` actor session was visible with replayed output through line 60. A fresh mid-stream `healthy-carpets-crash` actor daemon was reported running and opened in the dashboard, but its full-screen terminal rendered blank and the child remained alive after its command should have exited. Replay plus continued live output was therefore not re-verified end to end. |
| DAR-03 | 2026-07-22 | Copilot CLI | Windows x64 / Windows Terminal 1.24 + OpenConsole | 3.2.0 (`98bb7e1a`; SHA-256 `E454BC34278925C6E29F7A33A02A544F50A68243EA7FB50020D79A0F972E3965`) | Pass | Exact-candidate actors passed local dashboard ↔ Tunnel Link (`quick-shoe-3d10rcj.euw`, `lrzb71qj-3135.euw.devtunnels.ms`; access token omitted) handoff without fresh child output. Initial `thick-toes-pull` run encountered intermittent tunnel SSE resets; authoritative `poor-candies-brake` rerun with both local and Tunnel Link surfaces continuously attached confirmed: colored history and the local marker appeared immediately in the tunnel surface, the tunnel marker appeared immediately after local reclaim, scrolling reached line 001 and returned to the tunnel marker, and non-controller displaced input was rejected. Both DevTools captures contained zero `[handoff-debug:*]` messages. Exact-candidate attached actor `modern-wasps-clean` ran in a real 120x30 Windows Terminal/OpenConsole surface: dashboard takeover showed the displaced notice; a foreground Win32 `X` keyboard event was swallowed with the notice unchanged; a foreground Space keyboard event restored the prompt without inserting input, displaced the dashboard, and restored metadata to 120x30. |
| DAR-04 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | Requires an attached full-screen TUI and browser to observe restore and same-size repaint jiggles. |
| DAR-05 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Partial pass | A fresh actor session reached `needs-attention` after 10 seconds; selecting it in the dashboard changed persisted status to `acknowledged`. Resize stickiness while flagged could not be exercised because selecting the browser viewer acknowledged immediately and no real local console was available. |
| DAR-06 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | A PowerShell actor session emitted OSC 0 title `dar-title` and OSC 9;4 determinate progress `42`, but the same environment also showed shared blank/live-output and non-exit symptoms and did not provide a real interactive Windows console. Without actor-versus-legacy controls in a real console, this run cannot isolate a title/progress product defect from the broader ConPTY lifecycle failure. |
| DAR-07 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | Fresh headless `cmd.exe` fast-success and exit-7 sessions both remained `running` five seconds after `exit /b`, so final scrollback, terminal metadata, exact exit codes, and listener release could not be checked. The same non-exit behavior previously reproduced with the legacy engine in this host, so no actor-specific failure is claimed. |
| DAR-08 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Blocked | Playwright opened the same actor session in two browser pages and closing one left the other surface open, but the high-volume command never visibly streamed and activity stayed static. The core assertion — a slow or disconnected viewer must not stall a healthy viewer under outbound backpressure — was not exercised. |
| DAR-09 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Partial pass | The detached host was resolved uniquely by its `__session <id>` command line and force-terminated by PID. Metadata remained `running`, no final scrollback was written, and `climon kill <id>` removed the stale metadata, matching the documented forced-termination behavior. Console resize polling remains blocked because no interactive console was available. |
| DAR-10 | 2026-07-19 | Copilot CLI | Windows x64 | 3.2.0 (`e2459408`) | Partial pass | Invalid `future` selection failed with the exact expected message. Attached execution returned exit code 1; headless execution wrote the error to `sessions/<id>.log`, created no daemon log, and exited. Actor/legacy interactive I/O equivalence remains blocked by the non-interactive ConPTY environment. |

## Release-gate status

The Windows release gate is **not passed**. DAR-03 now passes its targeted
actor/Tunnel Link rerun. DAR-02, DAR-05, DAR-09, and DAR-10 are only partially
exercised; DAR-01, DAR-04, DAR-06, DAR-07, and DAR-08 remain blocked. Re-run the
remaining matrix from a real interactive Windows console with actor and legacy
controls, including the PWA surface, before changing the actor engine from
opt-in to default.
