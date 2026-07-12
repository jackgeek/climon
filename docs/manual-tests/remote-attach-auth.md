# Remote session attach authentication

Verifies that remote (devbox) sessions render in the dashboard terminal via the
authenticated loopback IPC proxy, and that attach failures are visible instead of
silently blanking the terminal.

Background: the Rust ingest (`climon __ingest`,
`rust/climon-remote/src/ingest.rs`) mints a per-session `.ipc-auth` credential and
runs the daemon side of the mutual-HMAC handshake
(`rust/climon-session/src/auth.rs`) on every inbound browser proxy connection, so
the Bun dashboard server's authenticated attach (`connectAuthenticatedSession`)
succeeds for remote sessions exactly as it does for local ones.

## RAA-1 — Remote terminal renders

**Feature:** Authenticated Rust ingest proxy for remote sessions
(`rust/climon-remote/src/ingest.rs`, `rust/climon-session/src/auth.rs`).

**Preconditions:** A devbox uplink connected to a local dashboard server over a
dev tunnel (or a WSL↔Windows direct link), with at least one live remote session
listed in the dashboard. Because each session's daemon runs the binary it was
launched from, the devbox `climon` must be rebuilt/reinstalled and the remote
session started **fresh** after this change for the fix to take effect.

**Steps:**
1. Open the dashboard and locate a remote (namespaced `label~id`) session.
2. Click the session to open its terminal.
3. Type a command in the terminal and observe output.

**Expected result:** The terminal renders live PTY output (not blank). The devbox
uplink log shows an `attach` line for the session after the browser connects.
Keystrokes reach the devbox and output streams back.

**Platforms:** macOS / Linux / Windows dashboard; devbox on Linux / WSL.

**Result tracking:**

| Date | Version | Tester | Platform | Pass/Fail | Notes |
|---|---|---|---|---|---|

## RAA-2 — Attach failure is visible

**Feature:** Observable attach failure
(`src/server/server.ts`, `src/web/components/TerminalView.tsx`).

**Preconditions:** As RAA-1.

**Steps:**
1. On the dashboard host, corrupt or delete the remote session's
   `~/.climon/sessions/<label~id>.ipc-auth` file (e.g. truncate it to `{`).
2. In the dashboard, open (or reopen) that session's terminal.

**Expected result:** The terminal shows a red line
`climon: cannot attach — …` rather than silently blanking, and the dashboard
server log records a `server.attach_failed` warning naming the session id.

**Platforms:** macOS / Linux / Windows dashboard.

**Result tracking:**

| Date | Version | Tester | Platform | Pass/Fail | Notes |
|---|---|---|---|---|---|
