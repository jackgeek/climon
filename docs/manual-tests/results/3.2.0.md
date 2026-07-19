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
| DAR-01 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Fail** | Shell input/output, `less`, and Vim passed. Actor exit changed tty `lflag` from `0x5cb` to `0x200005cb`; the equivalent legacy run restored the exact original mode. |
| DAR-02 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Headless daemon stayed running without a viewer, daemon log existed, and a mid-stream dashboard attach replayed prior output before continuing live through line 100. |
| DAR-03 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Browser control displayed the displacement notice, swallowed non-Space local input, and Space reclaimed with immediate replay. Local PTY resize propagated to `31x101`. |
| DAR-04 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Local restore repainted the complete Vim frame. With local and browser grids matched at `42x117`, same-size browser take-control repainted without a stale or half-painted screen. |
| DAR-05 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Fail** | Initial idle detection produced `needs-attention` and dashboard focus cleared it, but metadata became terminal status `acknowledged` instead of returning to `running`. After fresh output and more than two default idle intervals, it did not re-flag. |
| DAR-06 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | OSC 0/2 persisted and rendered `dar-title-2`; OSC 9;4 persisted normal progress at 42; clear removed progress. Raw title and progress sequences remained in final scrollback. |
| DAR-07 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Near-instant `done`/exit 0 and `boom`/exit 7 output was captured. Metadata, final scrollback, completion time, and status were correct; both loopback ports were released. |
| DAR-08 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Fail** | During a 300,000-line attached stream with two browser tabs, one viewer was closed abruptly. The command and local host exited, but metadata remained `running`, the socket was closed, and the surviving dashboard terminal was empty/disconnected. |
| DAR-09 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Unique `climon __session <id>` hosts handled SIGINT and SIGTERM gracefully: host and child exited, terminal metadata/completion time persisted, and ports closed. The local resize path exercised SIGWINCH reflow in DAR-03. |
| DAR-10 | 2026-07-19 | GitHub Copilot CLI | macOS 26.5.2 x86_64 | 3.2.0 | **Pass** | Unset/default, explicit actor, and explicit legacy runs all completed with identical output/status. Invalid attached and headless values emitted the exact required error; headless stderr appeared only in `sessions/<id>.log`. |

**Summary:** 7 passed, 3 failed.
