# Phase 8 — `climon-cli` core (daily-driver client)

These cases prove that the ported `climon` client binary (`rust/climon-cli`)
behaves like the TypeScript client for the day-to-day commands: starting a
monitored shell/command session, listing/killing sessions, `--version`/`--help`
byte-checks, `config` get/set/help, the new `licenses` notice dump, dashboard
`server` delegation, headless background sessions, and the Ctrl-\ detach flow.

Background: Phase 8 ports `src/cli/args.ts`, `src/client/detach-key.ts`,
`src/self-spawn.ts`, `src/spawn-daemon.ts`, `src/client/spawn-session.ts`,
`src/launcher.ts`, `src/client/connect.ts`, `src/cli/server-exec.ts`,
`src/cli/config-cmd.ts`, `src/detect-shell.ts`, and the `src/index.ts` dispatch
into the `climon-cli` crate. The parser is hand-rolled (not clap) to keep the
accepted argv surface — including bare-flag→shell, `--flag=value`, and the
hidden `__session`/`__uplink`/`__ingest`/`__update-check` entrypoints —
byte-for-byte compatible with the Bun client. The version is read from
`package.json` at build time so `climon --version` and the help banner are
byte-identical. Remote uplink/auto-link are Phase 9 no-op stubs; the
`update`/`setup`/`cleanup`/`link`/`uplink`/`ingest`/`update-check` handlers are
parseable but routed to a deferred stub. See the
[master plan](../superpowers/specs/2026-06-17-rust-client-rewrite-master-plan.md)
and the [Phase 8 plan](../superpowers/plans/2026-06-19-phase08-climon-cli.md).

This phase spans the **OS** dimension (shell detection, PATH lookup, detached
daemon spawn, raw-mode attach):

| Cell | OS | Parent-shell walk | Daemon detach | Attach raw mode |
|---|---|---|---|---|
| CLI-linux | Linux (x64) | `/proc/<pid>/exe` + `stat` | `setsid` | termios raw mode |
| CLI-macos | macOS (arm64) | `ps -o comm=,ppid=` | `setsid` | termios raw mode |
| CLI-win | Windows (x64) | PowerShell CIM walk | `DETACHED_PROCESS` | n/a (no controlling tty) |

Run the cases on each listed platform. Steps that differ per cell call it out.
All cases isolate state with a temp `CLIMON_HOME` so they never touch a real
`~/.climon`.

---

## MT-P8-01 — `climon-cli` builds, tests, and lints on all 3 OSes

- **ID:** MT-P8-01
- **Feature / phase:** Phase 8 — `climon-cli` crate
- **Preconditions:** Repo checked out; stable Rust toolchain with `rustfmt` +
  `clippy`; Bun installed for the cross-language fixture test.
- **Config-matrix cell:** all
- **Platforms:** macOS (arm64), Linux (x64), Windows (x64)

**Steps:**
1. From the repo root: `cd rust`.
2. Build: `cargo build -p climon-cli` (produces the `climon` binary).
3. Test: `cargo test -p climon-cli` (ported unit tests + `cli_fixtures`).
4. Lint gates: `cargo fmt --all --check` and
   `cargo clippy --workspace --all-targets -- -D warnings`.
5. License gate: `cargo deny check`; confirm `THIRD-PARTY-LICENSES.md` is
   regenerated and idempotent (`cargo about generate about.hbs`).
6. Cross-language fixtures (from repo root): `bun test tests/cli-fixtures.test.ts`.

**Expected:** All build/test/lint/deny steps pass; the Bun fixture test confirms
`helpText` and `--version` match `fixtures/cli/*` byte-for-byte.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P8-02 — `--version` / `--help` byte-check vs TS

- **ID:** MT-P8-02
- **Preconditions:** Built `climon` binary; Bun + repo for the TS reference.
- **Platforms:** all

**Steps:**
1. `climon --version` → capture stdout.
2. Compare with `fixtures/cli/version.txt` (`climon v<package.json version>\n`).
3. `climon --help` → capture stdout.
4. `diff` against `fixtures/cli/help.txt`.

**Expected:** Both outputs are byte-identical to the fixtures (which are
generated from the TS client). `licenses` does **not** appear in `--help`.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P8-03 — bare `climon` starts a monitored shell session

- **ID:** MT-P8-03
- **Preconditions:** `export CLIMON_HOME=$(mktemp -d)` (PowerShell: set
  `$env:CLIMON_HOME`).
- **Config-matrix cell:** CLI-linux / CLI-macos / CLI-win
- **Platforms:** all

**Steps:**
1. From an interactive shell, run `climon` with no args.
2. Observe the launch banner and that your shell is now running inside the PTY.
3. In another terminal, run `climon ls` (same `CLIMON_HOME`) and confirm the
   session is listed as `running` with a display command matching your shell.
4. Type `exit` in the monitored shell.

**Expected:** The detected parent shell is launched in a monitored session; the
session appears in `ls`; exiting the shell returns control with the shell's exit
code. On Windows the parent is detected via the PowerShell CIM walk.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P8-04 — `climon run <cmd>` and `--headless`

- **ID:** MT-P8-04
- **Preconditions:** temp `CLIMON_HOME`.
- **Platforms:** all

**Steps:**
1. `climon run bash -lc 'sleep 30'` (Windows: `climon run cmd /c "timeout 30"`).
2. Confirm the command runs attached; detach (MT-P8-08) or let it finish.
3. `climon run --headless bash -lc 'sleep 30'` → confirm it prints a session id
   and returns immediately (the daemon keeps running detached).
4. `climon ls` shows the headless session as `running`.
5. `climon run --color rojo foo` → confirm a parse error about valid colors.

**Expected:** Attached run relays the PTY; headless run spawns a detached daemon
and prints `<id>`; invalid color/priority flags produce the exact TS error text
and exit code 2.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P8-05 — `climon ls`, `climon kill <id>`, `climon kill --all`

- **ID:** MT-P8-05
- **Preconditions:** temp `CLIMON_HOME` with at least one active session.
- **Platforms:** all

**Steps:**
1. Start two headless sessions (MT-P8-04 step 3).
2. `climon ls` → note the two ids and the `!`-prefix column for any
   needs-attention session.
3. `climon kill <id>` for one → expect `Killed session <id>.`
4. `climon kill --all` → expect `Killed N climon session(s).` and/or
   `Removed N daemon-less climon session(s).`
5. `climon ls` → expect `No climon sessions found.`
6. `climon kill bogus-id` → expect `climon: No session found with id 'bogus-id'.`
   on stderr and exit 1.

**Expected:** Listing, single-kill, and kill-all match the TS messages and exit
codes; metadata is removed and daemons are terminated (SIGTERM then SIGKILL on
unix).

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P8-06 — `climon config` get / set / `--help`

- **ID:** MT-P8-06
- **Preconditions:** temp `CLIMON_HOME`.
- **Platforms:** all

**Steps:**
1. `climon config --help` → confirm the settings help (keys, defaults, scopes)
   renders; compare structure to TS `config --help`.
2. `climon config session.priority` on a fresh home → exits 1 (unset, no output).
3. `climon config session.priority 250` → writes the global config.
4. `climon config session.priority` → prints `250`.
5. `climon config --debug` → lists config files, keys, and values in resolution
   order.
6. `climon config remote.spawnSecret S3CR3T-do-not-leak` → writes the global
   config.
7. `climon config remote.spawnSecret` → prints `[REDACTED]`, not the raw secret.
8. `climon config --list` → includes `remote.spawnSecret=[REDACTED]` and does
   not include `S3CR3T-do-not-leak`.
9. `climon config bogus.key 1` → parse/validation error, exit 2.

**Expected:** Get/set/unset, `--help`, `--debug`, and `--purge` mirror the TS
config command output, scopes, and exit codes (parse error → 2, get-miss → 1,
runtime error → 2). Sensitive values are redacted in user-facing `get` and
`--list` output.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P8-07 — `climon licenses`

- **ID:** MT-P8-07
- **Preconditions:** Built `climon` binary.
- **Platforms:** all

**Steps:**
1. `climon licenses` → confirm it prints the embedded third-party license
   notices (starts with `# Third-Party Licenses`).
2. Confirm `climon --help` does **not** list a `licenses` line.

**Expected:** The notices embedded from `rust/THIRD-PARTY-LICENSES.md` are
printed verbatim; the command is intentionally hidden from help to keep the
help bytes identical to the TS client.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P8-08 — detach with `Ctrl-\` then `d`

- **ID:** MT-P8-08
- **Preconditions:** temp `CLIMON_HOME`; an attached session (MT-P8-03/04).
- **Config-matrix cell:** CLI-linux / CLI-macos (raw-mode unix)
- **Platforms:** macOS, Linux

**Steps:**
1. Start an attached session (`climon run bash`).
2. Press `Ctrl-\` (0x1c, the detach prefix) then `d` (0x64).
3. Confirm the terminal detaches and returns to your original shell while the
   session keeps running.
4. `climon ls` → the session is still `running`.
5. (Restore-clamped variant) Re-attach is out of Phase 8 scope; verify only the
   detach key handling here.

**Expected:** The `Ctrl-\ d` chord detaches without killing the session; the
prefix byte is consumed and not forwarded to the PTY. `Ctrl-\ c` is the
restore-clamped detach. The session continues under its daemon.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P8-09 — `climon server` delegation (with and without a sibling server)

- **ID:** MT-P8-09
- **Preconditions:** Built `climon` binary.
- **Platforms:** all

**Steps:**
1. With **no** `climon-server` binary next to `climon` and `CLIMON_SERVER_BIN`
   unset: run `climon server` → expect the exact message
   `climon: the dashboard server (climon-server) is not installed.` (plus the
   install hint line) on stderr and exit code 127.
2. Place a `climon-server` binary alongside `climon` (or set `CLIMON_SERVER_BIN`
   to a server binary): run `climon server --port 0` → confirm it execs the
   server with inherited stdio and `CLIMON_CLIENT_BIN` set to the client path.

**Expected:** Resolution order (CLIMON_SERVER_BIN → sibling `climon-server[.exe]`
→ bare `climon-server` on PATH) matches the TS client; missing server →
127 + exact message; present server → delegated exit code.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |
