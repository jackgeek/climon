# Cross-platform CI harness — smoke suite

Automated, deterministic end-to-end smoke cases for the climon Rust client and
Bun dashboard server together on GitHub-hosted macOS, Linux, and Windows
runners.

The harness builds the Rust client and Bun server from the checked-out commit,
runs a deterministic fixture program through the real client, and exercises the
session daemon, metadata store, server, dashboard, browser terminal, and PTY
path together. Both cases run the same `echo-session` fixture so terminal
assertions require no shell prompts, locale handling, or timing tricks.

Background: the [cross-platform CI harness
design](../superpowers/specs/2026-07-18-cross-platform-ci-harness-design.md)
and its [plan](../superpowers/plans/2026-07-18-cross-platform-ci-harness.md).

## Common preconditions

Unless a case says otherwise:

- A `climon` client **built from this branch** (`bun run build:rust` or the
  harness build fixture). Each session's daemon runs the binary it was launched
  from, so rebuild/reinstall before testing.
- A running `climon server` instance on loopback (the harness environment
  supervisor starts one automatically on an OS-assigned port and waits for
  `/health`).
- The harness uses an **isolated `CLIMON_HOME`** for each run; the fixture
  directory contains no real sessions, credentials, or user commands.
- The **deterministic echo-session fixture** (`harness/fixtures/echo-session.mjs`)
  is the command run in both cases. It prints `CIH_READY`, echoes `PING <token>`
  as `CIH_ECHO <token>`, and exits on `EXIT <code>`.

## Configuration matrix

| Cell | OS | PTY backend | IPC transport |
|---|---|---|---|
| CIH-linux | Linux (x64) | openpty | Unix domain socket / loopback TCP |
| CIH-macos | macOS (arm64) | openpty | Unix domain socket / loopback TCP |
| CIH-win | Windows (x64) | ConPTY | loopback TCP |

---

## CIH-01 — Headless client/server/dashboard lifecycle

- **ID:** CIH-01
- **Feature / phase:** Cross-platform CI harness — headless session; detached
  daemon; PTY; IPC; metadata; server; WebSocket bridge; xterm dashboard terminal;
  browser input; finalization
- **Preconditions:** Harness common preconditions; isolated CLIMON_HOME; source-built
  client and server artifacts.
- **Config-matrix cell:** all three platforms
- **Platforms:** macOS, Linux, Windows

```yaml harness
status: automated
suite: smoke
scenario: client-server.headless-dashboard
platforms: [macos, linux, windows]
timeoutSeconds: 120
```

**Steps:**

1. Start the deterministic echo-session fixture through the built client in
   headless (detached) mode:
   ```
   climon run --headless node harness/fixtures/echo-session.mjs
   ```
   The client prints the new session ID and returns immediately; the daemon runs
   in the background.
2. Capture the session ID printed by the client (first line of stdout).
3. Poll `climon ls --json` (or the server's session-list endpoint) until the
   session appears with status `running`.
4. Open the session terminal in Chromium via the dashboard URL for that session.
5. Wait for the fixture's `CIH_READY` marker to appear in the terminal via replay
   or live output.
6. Type and send a unique `PING <uuid>` token through the browser terminal input.
7. Wait for the matching `CIH_ECHO <uuid>` response to appear in the terminal
   output.
8. Type and send `EXIT 0` through the browser terminal.
9. Wait for the dashboard to report the session status as `completed`.
10. Read the persisted metadata file (`$CLIMON_HOME/sessions/<id>.json`) and
    verify `exitCode` is `0` and `status` is `completed`.

**Expected result:**

- The source-built client launches a detached headless session (step 1); the
  daemon owns the PTY and writes metadata.
- The session appears as `running` in `climon ls` and the dashboard (step 3).
- The Chromium terminal shows replay then live output; `CIH_READY` is visible
  (step 5).
- The browser terminal delivers `PING` input to the fixture through the
  WebSocket bridge and the PTY; `CIH_ECHO` is returned live (steps 6–7).
- `EXIT 0` causes the fixture to exit; the daemon finalises the session;
  the dashboard transitions to `completed` (steps 8–9).
- On-disk metadata records `exitCode: 0` and `status: "completed"` (step 10).

This proves the source-built client, detached daemon, PTY, metadata store,
source-built server, WebSocket bridge, xterm dashboard, browser input, and
finalization path all work together end-to-end.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## CIH-02 — Attached PTY lifecycle

- **ID:** CIH-02
- **Feature / phase:** Cross-platform CI harness — attached local-client path;
  node-pty PTY driver; scrollback replay to a late viewer; dashboard interop;
  clean PTY/client exit; finalization
- **Preconditions:** Harness common preconditions; isolated CLIMON_HOME; source-built
  client and server artifacts.
- **Config-matrix cell:** all three platforms
- **Platforms:** macOS, Linux, Windows

```yaml harness
status: automated
suite: smoke
scenario: client-server.attached-pty
platforms: [macos, linux, windows]
timeoutSeconds: 120
```

**Steps:**

1. Start the deterministic echo-session fixture through the built client inside
   `node-pty` (the harness PTY driver):
   ```
   climon run node harness/fixtures/echo-session.mjs
   ```
   The client runs attached inside the programmatic PTY; the fixture is hosted
   in-process by the local session host.
2. Wait for the `CIH_READY` marker to appear in the attached PTY output.
3. Poll the dashboard (or `climon ls --json`) until the session appears with
   status `running` and has a session ID.
4. Open the session terminal in the dashboard and verify the fixture output
   (`CIH_READY`) is observable through scrollback replay.
5. Send a unique `PING <uuid>` token through the **attached PTY** (via the
   node-pty stdin write).
6. Wait for `CIH_ECHO <uuid>` to appear in the attached PTY output.
7. Send `EXIT 0` through the attached PTY.
8. Wait for the PTY to receive `CIH_EXIT 0` output, and for the attached client
   process to exit cleanly (exit code 0).
9. Wait for the dashboard to report the session status as `completed`.
10. Read the persisted metadata file (`$CLIMON_HOME/sessions/<id>.json`) and
    verify `exitCode` is `0` and `status` is `completed`.

**Expected result:**

- The source-built client runs attached inside `node-pty`; the session host
  owns the PTY in-process (step 1).
- `CIH_READY` is visible in the attached terminal output (step 2).
- The session appears as `running` in the dashboard (step 3).
- Scrollback replay delivers the `CIH_READY` output to the dashboard viewer
  (step 4); the dashboard does not need to take control from the attached terminal.
- `PING` input sent through the local PTY reaches the fixture and returns
  `CIH_ECHO` in the same PTY (steps 5–6); the input path is the attached local
  client, not the browser.
- `EXIT 0` causes the fixture to exit; the session host finalises; the client
  and PTY exit cleanly with code 0 (steps 7–8).
- The dashboard transitions to `completed` (step 9); on-disk metadata records
  `exitCode: 0` (step 10).

This proves the attached local-client path while still validating server and
dashboard interoperability. The browser terminal is a passive viewer; it does
not take control from the attached terminal.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
