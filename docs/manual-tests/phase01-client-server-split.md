# Phase 1 — Client/server split: compiled `climon-server` binary

These cases prove that releases ship a real, runnable compiled `climon-server`
binary (the canonical and Rust-facing server path) **and** that the existing Bun
client's in-process `climon-beta` bundle path still works unchanged.

Background: before Phase 1 the server shipped only as the in-process `climon-beta`
JS bundle. Phase 1 makes `scripts/compile.ts` compile `src/server.ts` into a
standalone `climon-server[.exe]` and adds it to the install manifest, so it is
installed and update-swapped automatically. See
[`docs/architecture.md`](../architecture.md) → *Dashboard server*.

No configuration matrix applies to this phase: it is single-environment per OS.
Run the cases independently on each platform listed.

---

## MT-P1-01 — Release zip contains a runnable `climon-server`

- **ID:** MT-P1-01
- **Feature / phase:** Phase 1 — packaging
- **Preconditions:** Repo checked out; `bun install` done; able to run
  `bun run compile` (downloads cross-compile base binaries on first run).
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows (run on the host whose zip you extract)

**Steps:**
1. Build the release artifacts: `bun run compile`.
2. List `dist/` and confirm one `climon-<platform>.zip` per target, and nothing
   else (`dist/` contains only zips).
3. Extract the zip for the current host (e.g. `unzip dist/climon-darwin-arm64.zip
   -d /tmp/climon-mt01`).
4. Confirm the extracted entries are exactly: `install`, `climon-server`,
   `climon-beta`, `climon-alpha` (with `.exe` on `install`/`climon-server` on
   Windows).
5. Run the extracted server binary directly in an isolated home and a free port:
   - Unix: `CLIMON_HOME=/tmp/mt01-home /tmp/climon-mt01/climon-server server --no-takeover --port 0`
   - Windows (PowerShell): `$env:CLIMON_HOME='C:\Temp\mt01-home'; .\climon-server.exe server --no-takeover --port 0`
6. Open the dashboard URL the server selected (check
   `"$CLIMON_HOME"/server.json` for the bound `port`, then browse
   `http://127.0.0.1:<port>/`). Stop the server (Ctrl-C).

**Expected result:**
- Each platform zip exists and contains all four entries in step 4.
- The standalone `climon-server` binary starts, writes `server.json`, and serves
  the dashboard at the bound port (a session list page loads). No "missing
  bundle"/"cannot start server" error.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P1-02 — Install lays down `climon`, `climon-server`, and `climon-beta`

- **ID:** MT-P1-02
- **Feature / phase:** Phase 1 — install manifest
- **Preconditions:** A `climon-<platform>.zip` from MT-P1-01 extracted to a temp
  dir.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. From the extracted dir, run the installer binary (`install` / `install.exe`)
   to install into a throwaway prefix (use the installer's prompts / flags, or
   point `CLIMON_HOME` at a temp dir to avoid touching a real install).
2. Inspect the install directory the installer reported.

**Expected result:**
- The install directory contains `climon` (from `install`), `climon-server`, and
  `climon-beta` (with `.exe` suffixes on Windows for `climon`/`climon-server`).
- `climon --version` runs; `climon-server server --no-takeover --port 0` starts
  the dashboard (as in MT-P1-01).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P1-03 — Spawned-binary server path (the future Rust client path)

- **ID:** MT-P1-03
- **Feature / phase:** Phase 1 — `server-exec` canonical contract
- **Preconditions:** Installed `climon` and `climon-server` from MT-P1-02 (or the
  extracted binaries from MT-P1-01).
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

> **How the spawned path is reached.** `delegateToServer` *always tries the
> in-process `climon-beta` bundle first* and only falls back to spawning a
> separate process when no bundle resolves (no `CLIMON_SERVER_BUNDLE` override
> **and** no sibling `climon-beta` next to the client). `CLIMON_SERVER_BIN` only
> selects *which* binary that fallback spawns. So to exercise the spawn path you
> must make the in-process bundle unresolvable.

**Steps:**
1. Make the in-process bundle unresolvable so delegation falls back to spawning:
   ensure `CLIMON_SERVER_BUNDLE` is unset and temporarily move the sibling
   `climon-beta` out of the install dir (e.g. rename to `climon-beta.bak`).
2. Point `CLIMON_SERVER_BIN` at the installed `climon-server` and start the
   server through the client:
   - Unix: `CLIMON_HOME=/tmp/mt03-home CLIMON_SERVER_BIN=<dir>/climon-server climon server`
   - Windows: `$env:CLIMON_HOME='C:\Temp\mt03-home'; $env:CLIMON_SERVER_BIN='<dir>\climon-server.exe'; climon server`
3. In a second terminal (same `CLIMON_HOME`), start a session: `climon -- bash`
   (Unix) / `climon -- powershell` (Windows).
4. Open the dashboard, confirm the session is listed, attach in the browser, type
   a command, and confirm output streams. Detach.
5. Restore the `climon-beta` bundle you moved in step 1.

**Expected result:**
- With no resolvable bundle, `delegateToServer` falls through to spawning the
  server binary, and `CLIMON_SERVER_BIN` makes it exec the installed
  **`climon-server` process** (verify via `ps`/Task Manager: a `climon-server`
  child exists). The session is visible and controllable in the browser. This is
  exactly the path the future Rust client will use.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P1-04 — In-process `climon-beta` path preserved (Bun client)

- **ID:** MT-P1-04
- **Feature / phase:** Phase 1 — Bun-client back-compat
- **Preconditions:** Installed `climon` with a sibling `climon-beta` bundle (from
  MT-P1-02). `CLIMON_SERVER_BUNDLE` **unset** and the `climon-beta` sibling
  present (restored, if you ran MT-P1-03).
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. With the sibling `climon-beta` present, start the server through the client:
   `CLIMON_HOME=/tmp/mt04-home climon server`. (The in-process bundle is
   preferred automatically whenever it resolves, regardless of
   `CLIMON_SERVER_BIN`.)
2. Start a session against the same `CLIMON_HOME` and verify it in the browser as
   in MT-P1-03.
3. (Optional) Confirm no separate `climon-server` process was spawned for the
   server (e.g. `ps`/Task Manager shows the dashboard served by the `climon`
   client process, not a child `climon-server`).

**Expected result:**
- The dashboard starts via the **in-process `climon-beta` bundle**
  (`runServerInProcess`), with no `climon-server` child process. Sessions are
  visible and controllable. This confirms Phase 1 preserved the existing Bun
  client behaviour (the in-process path is retired only at the Rust cutover,
  Phase 12).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
