# Phase 6 — `climon-pty` crate (PTY / terminal primitives)

These cases prove that the ported PTY layer (`rust/climon-pty`) behaves like the
TypeScript client's `src/pty.ts` across the three first-class platforms, on real
PTYs that CI's GitHub-hosted VMs can exercise but unit tests alone cannot fully
characterize (controlling-terminal/job-control behavior, `SIGWINCH` propagation
to nested TUIs, Windows ConPTY). They cover PTY spawn + output capture, the
`setsid -c` controlling-terminal wrapping, the default `TERM`, resize
clamp/de-dupe with `SIGWINCH` delivery to descendants, raw-mode termios
handling, terminal-size queries, exit-code propagation, and the license gate.

Background: Phase 6 ports `src/pty.ts` and absorbs the proof-of-concept modules
`rust/climon-rs/src/{term,scrollback}.rs` plus the PTY-spawn mechanics of
`rust/climon-rs/src/host.rs` into a reusable, pull-based `Pty` abstraction built
on `portable-pty` (Unix `openpty` / Windows ConPTY). The socket/viewer/relay
protocol stays in the PoC and is Phase 7's job. See the
[master plan](../superpowers/specs/2026-06-17-rust-client-rewrite-master-plan.md)
and the [Phase 6 plan](../superpowers/plans/2026-06-18-phase06-climon-pty.md).

This phase is the first with **per-OS PTY-backend** differences, so several
cases are a configuration matrix over the PTY backend dimension:

| Cell | OS | PTY backend | `setsid` | `SIGWINCH` | raw-mode (termios) |
|---|---|---|---|---|---|
| PTY-unix-linux | Linux (x64) | `openpty` | present (util-linux) | yes | yes |
| PTY-unix-macos | macOS (arm64) | `openpty` | usually absent | yes | yes |
| PTY-win | Windows (x64) | ConPTY | n/a | n/a (no-op) | n/a (no-op) |

Run the cases on each listed platform. Steps that differ per cell call it out.

---

## MT-P6-01 — `climon-pty` builds, tests, and lints on all 3 OSes

- **ID:** MT-P6-01
- **Feature / phase:** Phase 6 — `climon-pty` crate
- **Preconditions:** Repo checked out; stable Rust toolchain with `rustfmt` +
  `clippy`.
- **Config-matrix cell:** all
- **Platforms:** macOS (arm64), Linux (x64), Windows (x64)

**Steps:**
1. From the repo root: `cd rust`.
2. Build: `cargo build -p climon-pty`.
3. Test: `cargo test -p climon-pty` (unit modules + `pty_integration`).
4. Lint gates: `cargo fmt --all --check` and
   `cargo clippy --workspace --all-targets -- -D warnings`.

**Expected result:**
- The crate compiles and all `climon-pty` tests are green on each platform,
  including the real-PTY integration tests (which spawn `/bin/sh` on Unix and
  `cmd` on Windows).
- `fmt --check` reports no diffs; `clippy -D warnings` produces no warnings.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P6-02 — PTY spawn + output capture + exit-code propagation

- **ID:** MT-P6-02
- **Feature / phase:** Phase 6 — spawn / read / wait
- **Preconditions:** `cd rust && cargo build -p climon-pty`.
- **Config-matrix cell:** all
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Run the integration suite explicitly:
   `cargo test -p climon-pty --test pty_integration`.
2. Observe `spawns_and_reads_output` (a child writes `hi`, the reader receives
   it, `wait()` returns `0`) and `propagates_nonzero_exit_code`
   (`sh -c 'exit 7'` → `wait()` returns `7`).
3. (Manual cross-check, Unix) From a shell:
   `cargo run -q -p climon-rs -- run -- /bin/sh -lc 'echo phase6 && exit 3'` is
   *not* required for this crate, but you may sanity-check spawn behavior with a
   small scratch binary that calls `Pty::spawn`.

**Expected result:**
- Output bytes from the child are read through the cloned reader.
- The exit code returned by `Pty::wait()` matches the child's exit status
  (`0` and `7` respectively), via `portable-pty`'s `ExitStatus::exit_code()`.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P6-03 — `setsid` controlling-terminal wrapping + job control

- **ID:** MT-P6-03
- **Feature / phase:** Phase 6 — `buildSpawnArgv` / `setsid -c`
- **Preconditions:** `cd rust`.
- **Config-matrix cell:** PTY-unix-linux (primary), PTY-unix-macos, PTY-win
- **Platforms:** Linux, macOS, Windows

**Steps:**
1. **Linux (setsid present):** Spawn an interactive shell through `Pty::spawn`
   (e.g. a scratch harness running `/bin/bash -i` at 80×24) and confirm the
   shell does **not** print "cannot set terminal process group" / "no job
   control in this shell". Inside it, run `jobs`, start `sleep 100 &`, then
   `fg`/Ctrl-Z and confirm job control works.
2. Confirm `setsid` was used: the argv is `[setsid, -c, /bin/bash, -i]`. You can
   confirm by checking `which setsid` resolves and that the shell has a
   controlling terminal (`ps -o tty= -p $$` shows a `pts/...`).
3. **macOS (setsid usually absent):** Repeat. The command runs unwrapped; job
   control warnings *may* appear (same as the TS client). Confirm the process
   still spawns and reads/writes correctly.
4. **Windows:** Confirm spawning works under ConPTY with no `setsid` involved.

**Expected result:**
- On Linux, `setsid -c` wrapping gives the child a controlling terminal and job
  control works without warnings.
- On macOS without `setsid`, behavior matches the unwrapped TS client.
- On Windows, ConPTY handles controlling-terminal semantics; no `setsid`.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P6-04 — Default `TERM` and provided-env override

- **ID:** MT-P6-04
- **Feature / phase:** Phase 6 — environment handling
- **Preconditions:** `cd rust`.
- **Config-matrix cell:** all
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Spawn `sh -c 'printf %s "$TERM"'` (Unix) with `env: None` from an environment
   where `TERM` is unset; capture the output.
2. Spawn the same with `env: Some({ "PATH": ... })` that does **not** include
   `TERM`.
3. Spawn with `env: Some({ "CLIMON_PTY_TEST": "marker-value" })` and a child
   that echoes that variable (covered by `provided_env_is_applied`).

**Expected result:**
- Steps 1–2: the child sees `TERM=xterm-256color` (defaulted when unset, for
  both the inherited and provided-env paths).
- Step 3: the provided environment is applied (the marker value is echoed),
  replacing the inherited environment.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P6-05 — Resize clamp/de-dupe + `SIGWINCH` to nested TUIs

- **ID:** MT-P6-05
- **Feature / phase:** Phase 6 — `Pty::resize`
- **Preconditions:** `cd rust`.
- **Config-matrix cell:** PTY-unix-linux, PTY-unix-macos (primary); PTY-win
  (clamp/de-dupe only)
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Run `cargo test -p climon-pty --test pty_integration resize_dedupes_and_does_not_panic`:
   confirm `resize(80,24)` at the current size returns `false` (no change),
   `resize(100,40)` returns `true`, re-applying returns `false`, and `resize(0,0)`
   clamps to `(1,1)`.
2. **Nested-TUI `SIGWINCH` (Unix, manual):** Through a scratch harness, spawn a
   shell that launches a grandchild TUI that redraws on `SIGWINCH` (e.g.
   `/bin/sh -c 'exec vim'`, or `htop`, or a small program printing
   `$(tput cols)x$(tput lines)` on each `SIGWINCH`). Call `Pty::resize` to a new
   size and confirm the **grandchild** re-reads and redraws at the new size (not
   just the direct child).
3. **Windows:** Confirm `resize` clamps/de-dupes and applies via ConPTY without
   panicking; `SIGWINCH` is not applicable.

**Expected result:**
- Clamp (`>= 1`) and de-dupe semantics match `src/pty.ts`.
- On Unix the nested grandchild TUI redraws at the new size, proving `SIGWINCH`
  reaches descendants, not just the direct child.
- On Windows the resize applies through ConPTY with no signal and no panic.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P6-06 — Raw mode + terminal-size query

- **ID:** MT-P6-06
- **Feature / phase:** Phase 6 — `RawMode` / `terminal_size`
- **Preconditions:** `cd rust`.
- **Config-matrix cell:** PTY-unix-linux, PTY-unix-macos (primary); PTY-win
  (no-op)
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. **Unit:** `cargo test -p climon-pty term` — confirm `terminal_size` on a
   non-tty pipe returns the default `(80, 24)` and `RawMode::enable` on a
   non-tty is a successful no-op.
2. **Interactive (Unix, manual):** In a real terminal, enable `RawMode` on the
   stdin fd via a scratch harness, type some keys (confirm no line echo / no
   canonical line editing), then drop the guard and confirm the terminal is
   restored to cooked mode (echo + line editing back). Resize the window and
   confirm `terminal_size(STDIN)` reflects the new dimensions.
3. **Windows:** Confirm `RawMode::enable` returns a no-op guard and
   `terminal_size` returns the default (ConPTY is driven by an explicit caller
   size).

**Expected result:**
- Non-tty fds are no-ops with the default size.
- On a real Unix TTY, raw mode disables echo/canonical processing and is
  restored on drop; `terminal_size` reflects the live window size.
- On Windows the helpers are safe no-ops/defaults.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P6-07 — License gate + attribution freshness (`portable-pty` added)

- **ID:** MT-P6-07
- **Feature / phase:** Phase 6 — license tooling
- **Preconditions:** `cargo-deny` and `cargo-about` installed. `cd rust`.
- **Config-matrix cell:** n/a
- **Platforms:** Linux (CI parity); optionally macOS/Windows

**Steps:**
1. Baseline: `cargo deny check` — advisories/bans/licenses/sources all ok.
   `portable-pty` and its transitive crates are MIT; the `serial` advisory
   (RUSTSEC-2017-0008, transitive via `portable-pty`) is already documented in
   `deny.toml`'s ignore list. A `multiple-versions` *warning* for `windows-sys`
   (0.59 via `climon-store`, 0.61 via `signal-hook` in the PoC) is expected and
   non-fatal.
2. Attribution freshness: regenerate and diff against the committed file:
   `cargo about generate about.hbs > NOTICES.tmp.md && diff -u THIRD-PARTY-LICENSES.md NOTICES.tmp.md && rm NOTICES.tmp.md`
   — expect **no diff**.

**Expected result:**
- Step 1 passes; only the expected `windows-sys` duplicate *warning* appears.
- Step 2 produces no diff (the committed `THIRD-PARTY-LICENSES.md` is current
  and lists `climon-pty` under MIT).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
