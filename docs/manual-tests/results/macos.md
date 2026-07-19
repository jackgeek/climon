# Manual test results — climon 3.2.0

- **Date:** 2026-07-19
- **Tester:** GitHub Copilot CLI
- **Original matrix commit:** `6b08e5a76df32845d0ca41099aeed22f6432acc3`
- **Remediation rerun candidate:** `77cbc91b3381da198f14c51f3bc4ea6b6aa99db9`
- **Platform:** macOS 26.5.2, x86_64
- **Browser:** Chromium via Playwright
- **Session engine:** `CLIMON_SESSION_ENGINE=actor` unless a case explicitly tests engine selection

The documented DAR-macos matrix cell names macOS arm64. This run used the
available x86_64 macOS host and x86_64 branch-built binary.

## Daemon actor rewrite

| ID | Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| DAR-01 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 (`77cbc91b`) | **Pass (reclassified)** | Shell input/output, `less`, Vim, local echo, and line editing passed. The only `lflag` delta was macOS `PENDIN` (`0x20000000`). The remediation candidate's controlled real-PTY test `shutdown_restores_cooked_flags_and_preserves_unread_input_despite_pendin` reproduces that delta after `LocalTerminalSetup::shutdown`, while proving `ECHO`, `ICANON`, `ISIG`, and `IEXTEN` are restored and queued input remains readable. This is a transient kernel status bit, not a mode-restoration defect. |
| DAR-02 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Headless daemon stayed running without a viewer, daemon log existed, and a mid-stream dashboard attach replayed prior output before continuing live through line 100. |
| DAR-03 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Browser control displayed the displacement notice, swallowed non-Space local input, and Space reclaimed with immediate replay. Local PTY resize propagated to `31x101`. |
| DAR-04 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Local restore repainted the complete Vim frame. With local and browser grids matched at `42x117`, same-size browser take-control repainted without a stale or half-painted screen. |
| DAR-05 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 (`77cbc91b`) | **Pass** | With `attention.idleSeconds=2`, a real dashboard run reached `needs-attention` and auto-acknowledged to the correct durable `acknowledged` status. A controlled persistent body change then produced `acknowledged` → `running`; after a fresh idle interval the dashboard auto-acknowledged the new attention episode, proving the re-flag occurred. The rerun also exposed and fixed a real edge case: controller input arriving during the viewer resize-settle window was previously misclassified with its output as resize redraw. `note_program_input` now ends that settle window in both actor and legacy paths, with actor-level and shared-detector regressions. |
| DAR-06 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | OSC 0/2 persisted and rendered `dar-title-2`; OSC 9;4 persisted normal progress at 42; clear removed progress. Raw title and progress sequences remained in final scrollback. |
| DAR-07 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Near-instant `done`/exit 0 and `boom`/exit 7 output was captured. Metadata, final scrollback, completion time, and status were correct; both loopback ports were released. |
| DAR-08 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 (`77cbc91b`) | **Pass** | Re-ran with an attached real pseudo-terminal and two Playwright browser tabs. During a paced 3,000-line stream one browser tab was closed abruptly; the surviving browser remained attached through completion, the local PTY capture contained all 3,000 lines through `DAR08-ATTACHED-002999`, persisted scrollback retained the final tail, metadata finalized `completed`/exit 0, and the daemon log contained no panic/error. A separate 100,000-line headless run also completed without the prior `vt100::Grid::col_wrap` crash or stale `running` metadata. |
| DAR-09 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Unique `climon __session <id>` hosts handled SIGINT and SIGTERM gracefully: host and child exited, terminal metadata/completion time persisted, and ports closed. The local resize path exercised SIGWINCH reflow in DAR-03. |
| DAR-10 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Unset/default, explicit actor, and explicit legacy runs all completed with identical output/status. Invalid attached and headless values emitted the exact required error; headless stderr appeared only in `sessions/<id>.log`. |

**Summary:** All 10 macOS cells are now classified Pass after targeted
remediation reruns. Seven unchanged cells remain evidence from the original
matrix commit; the final cross-platform release gate still requires one
same-candidate sweep before changing the default engine.
