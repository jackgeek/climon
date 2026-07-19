# Manual test results — climon 3.2.0

- **Date:** 2026-07-19
- **Tester:** GitHub Copilot CLI
- **Commit:** `6b08e5a76df32845d0ca41099aeed22f6432acc3`
- **Platform:** macOS 26.5.2, x86_64
- **Browser:** Chromium via Playwright
- **Session engine:** `CLIMON_SESSION_ENGINE=actor` unless a case explicitly tests engine selection

The documented DAR-macos matrix cell names macOS arm64. This run used the
available x86_64 macOS host and x86_64 branch-built binary.

## Daemon actor rewrite

| ID | Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|---|
| DAR-01 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass (reclassified)** | Shell input/output, `less`, Vim, local echo, and line editing passed. The only `lflag` delta was macOS `PENDIN` (`0x20000000`). Controlled real-PTY coverage in `adapters::local_terminal::tests::shutdown_restores_cooked_flags_and_preserves_unread_input_despite_pendin` (`01d13d3d`) reproduces that delta after `LocalTerminalSetup::shutdown`, while proving `ECHO`, `ICANON`, `ISIG`, and `IEXTEN` are restored and queued input remains readable. This is a transient kernel status bit, not a mode-restoration defect. |
| DAR-02 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Headless daemon stayed running without a viewer, daemon log existed, and a mid-stream dashboard attach replayed prior output before continuing live through line 100. |
| DAR-03 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Browser control displayed the displacement notice, swallowed non-Space local input, and Space reclaimed with immediate replay. Local PTY resize propagated to `31x101`. |
| DAR-04 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Local restore repainted the complete Vim frame. With local and browser grids matched at `42x117`, same-size browser take-control repainted without a stale or half-painted screen. |
| DAR-05 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Partial** | Initial idle detection produced `needs-attention` and dashboard focus correctly cleared it to the non-terminal durable status `acknowledged`; expecting `running` was a test-spec error. The reported failure to re-flag remains inconclusive because the run did not prove the visible fingerprint body changed rather than settling back to the same screen. Re-run with the updated deterministic procedure: leave a distinct output line visible, confirm `acknowledged` → `running`, then wait one full fresh idle interval for `needs-attention`. |
| DAR-06 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | OSC 0/2 persisted and rendered `dar-title-2`; OSC 9;4 persisted normal progress at 42; clear removed progress. Raw title and progress sequences remained in final scrollback. |
| DAR-07 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Near-instant `done`/exit 0 and `boom`/exit 7 output was captured. Metadata, final scrollback, completion time, and status were correct; both loopback ports were released. |
| DAR-08 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Fail** | During a 300,000-line attached stream with two browser tabs, one viewer was closed abruptly. The command and local host exited, but metadata remained `running`, the socket was closed, and the surviving dashboard terminal was empty/disconnected. |
| DAR-09 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Unique `climon __session <id>` hosts handled SIGINT and SIGTERM gracefully: host and child exited, terminal metadata/completion time persisted, and ports closed. The local resize path exercised SIGWINCH reflow in DAR-03. |
| DAR-10 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Unset/default, explicit actor, and explicit legacy runs all completed with identical output/status. Invalid attached and headless values emitted the exact required error; headless stderr appeared only in `sessions/<id>.log`. |

**Summary:** 8 passed, 1 partial, 1 failed.
