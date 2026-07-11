# Phase 16 — Remotes visibility

Manual checks for the remote-visibility surface: the `ingest-status.json` /
`uplink-status.json` status beacons, the `climon remotes` CLI (`--watch` /
`--json`, healthy/stale `●`/`○`), and the ingest-side sanitization of
attacker-controlled `hello.hostname`/`hello.os` (review findings C1/C2/C3).

| Cell | Scenario | Notes |
|---|---|---|
| REM-CONNECT | Connect → appears | Friendly hostname/OS in CLI. |
| REM-STALE | Disconnect → stale → clears | Reader-derived staleness. |
| REM-WATCH | `--watch` live updates | Redraw on connect/disconnect. |
| REM-JSON | `--json` parseable | `jq .` ok; keys `uplink`/`ingest`/`remotesEnabled`. |
| REM-DISABLED | Disabled hint | Neither `feature.remotes` nor `feature.wslBridge`. |
| REM-LEGACY | Old uplink, no hostname | Falls back to `clientId`, os `unknown`. |
| REM-SEC | Malicious hostname/os | Truncated, no escapes, `os`→`unknown`. |

---

## MT-P16-01 — Connected remote appears in the CLI

- **ID:** MT-P16-01
- **Feature / phase:** Remotes visibility — connection listing
- **Preconditions:** Home machine with `feature.remotes` enabled and `climon
  server` running; a devbox with a freshly built Rust `climon` connected over a
  dev tunnel (a devbox session shows on the home dashboard).
- **Config-matrix cell:** REM-CONNECT
- **Platforms:** Linux/macOS/Windows (home) + Linux (devbox)

**Steps:**
1. On home, run `climon remotes`.
2. Note the devbox's hostname/OS/address/session-count.

**Expected result:** The devbox is listed under the ingest section with a
leading `●`, its friendly hostname and OS, address, and current session count.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P16-02 — Disconnect goes stale then clears

- **ID:** MT-P16-02
- **Feature / phase:** Remotes visibility — reader-derived staleness
- **Preconditions:** As MT-P16-01, with the devbox connected and listed.
- **Config-matrix cell:** REM-STALE
- **Platforms:** Linux/macOS/Windows (home) + Linux (devbox)

**Steps:**
1. Confirm the devbox shows `●` (healthy) in `climon remotes`.
2. Stop the devbox uplink (or disconnect the tunnel).
3. Re-run `climon remotes` within ~30s, then again after the ingest heartbeat
   drops the entry.

**Expected result:** Shortly after disconnect the entry flips to `○` (STALE) —
because the reader derives staleness from the missing ping/heartbeat, not a
flag in the file — and then clears from the list once the ingest stops
advertising it.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P16-03 — `--watch` updates live

- **ID:** MT-P16-03
- **Feature / phase:** Remotes visibility — `climon remotes --watch`
- **Preconditions:** Home machine with `feature.remotes` enabled and `climon
  server` running; a devbox available to connect/disconnect.
- **Config-matrix cell:** REM-WATCH
- **Platforms:** Linux/macOS/Windows (home) + Linux (devbox)

**Steps:**
1. On home run `climon remotes --watch` in a TTY.
2. Connect the devbox uplink and watch the screen.
3. Disconnect the devbox uplink and keep watching.

**Expected result:** The view clears and redraws on its interval: the host
appears (`●`) when the uplink connects and transitions to stale/removed when it
disconnects, without restarting the command. `Ctrl-C` exits cleanly.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P16-04 — `--json` shape is stable and parseable

- **ID:** MT-P16-04
- **Feature / phase:** Remotes visibility — `climon remotes --json`
- **Preconditions:** Home machine with `feature.remotes` enabled; `jq`
  installed.
- **Config-matrix cell:** REM-JSON
- **Platforms:** Linux/macOS/Windows

**Steps:**
1. Run `climon remotes --json | jq .`.
2. Inspect the top-level keys.
3. Pipe with a devbox connected and disconnected.

**Expected result:** `jq .` parses without error; the object has stable
top-level keys (`uplink`, `ingest`, `remotesEnabled`, plus the derived
`uplinkStale`/`ingestStale`). `--json` never clears the screen or emits ANSI
glyphs, so it is safe to consume programmatically.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P16-05 — Disabled-remotes hint

- **ID:** MT-P16-05
- **Feature / phase:** Remotes visibility — disabled hint
- **Preconditions:** A machine where **neither** `feature.remotes` nor
  `feature.wslBridge` is enabled.
- **Config-matrix cell:** REM-DISABLED
- **Platforms:** Linux/macOS/Windows

**Steps:**
1. Confirm both flags are off (`climon config feature.remotes`,
   `climon config feature.wslBridge`).
2. Run `climon remotes`.
3. Open the dashboard hamburger menu and look for the **Remotes** item.

**Expected result:** The CLI prints a short hint that remotes are disabled (and
how to enable them) instead of an empty list; the dashboard hamburger menu hides
the **Remotes** item entirely while `feature.remotes` is off.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P16-06 — Legacy uplink without hostname still lists

- **ID:** MT-P16-06
- **Feature / phase:** Remotes visibility — hello fallback
- **Preconditions:** Home machine with `feature.remotes` enabled; a devbox
  running an **older** client that sends a `hello` **without** `hostname`/`os`
  (or a forced hello omitting them).
- **Config-matrix cell:** REM-LEGACY
- **Platforms:** Linux/macOS/Windows (home) + Linux (devbox)

**Steps:**
1. Connect the legacy/forced uplink that omits `hostname`/`os`.
2. Run `climon remotes`.

**Expected result:** The connection still lists (not dropped): the hostname
falls back to the bounded `clientId` and the OS renders as `unknown`. Session
count and stale/healthy state still work.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_

---

## MT-P16-07 — Malicious hello identity is sanitized (C1/C2)

- **ID:** MT-P16-07
- **Feature / phase:** Remotes visibility — ingest-side identity sanitization
- **Preconditions:** Home machine with `feature.remotes` enabled and `climon
  server` running; a devbox (or a crafted uplink/hello) able to advertise an
  arbitrary `hostname`/`os`. Run `climon remotes` in a **real TTY**.
- **Config-matrix cell:** REM-SEC
- **Platforms:** Linux/macOS/Windows (home) + Linux (devbox)

**Steps:**
1. Have the devbox connect advertising a `hostname` that is both **oversized**
   (>64 chars) and laced with ANSI escapes, e.g. `$'\e[2J\e[31mPWNED'` plus a
   long padding suffix, and `os: $'linux\e]0;x\a'`.
2. On home, run `climon remotes` in a real terminal and observe the output and
   the terminal title.
3. Inspect `~/.climon/ingest-status.json`.

**Expected result:** The hostname is truncated to **64 chars** with the `ESC`
bytes stripped, so there is **no** clear-screen/color effect and the terminal
title is unchanged; `os` renders as `unknown`. `ingest-status.json` contains no
`ESC` (`\u001b`) bytes and the stored hostname is ≤64 chars.

- **Result:** _date / tester / platform / config-matrix cell / pass-fail / notes_
