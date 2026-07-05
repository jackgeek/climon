# `climon shell` command + bare `climon` shows help — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the "start a monitored session for the current shell" behavior from bare `climon` to an explicit `climon shell` command, and make bare `climon` (and leading-session-flags-with-no-command) print a friendly note followed by the help text.

**Architecture:** Argument parsing lives in the Rust client `rust/climon-cli/src/args.rs` (`parse_args`), dispatched by `rust/climon-cli/src/main.rs`. The `ParsedCommand::Help` variant gains an `implicit: bool` so `main.rs` can print the friendly note only on the implicit path, keeping explicit `climon --help` byte-for-byte identical to the shared golden fixture `fixtures/cli/help.txt`. A new `shell` subcommand parses the existing session flags (`--priority`/`--color`/`--name`/`--theme`). The frozen TypeScript mirror `src/cli/args.ts` (consumed by the Bun dashboard server entrypoint and pinned to the same fixture) is updated to keep `helpText` and the parsed shape in sync.

**Tech Stack:** Rust (cargo, crate `climon-cli`), TypeScript/Bun (`bun test`), shared golden fixture `fixtures/cli/help.txt`.

---

## File Structure

- `rust/climon-cli/src/args.rs` — parser + help text + Rust unit tests. `ParsedCommand::Help` becomes `Help { implicit: bool }`; add `shell` subcommand parsing; no-args and leading-flags-only → `Help { implicit: true }`; `help_text` first usage line changes to `climon shell …`.
- `rust/climon-cli/src/main.rs` — dispatch: update the `Help` arm to print the friendly note to stderr when `implicit`; update `command_name`'s `Help` pattern.
- `fixtures/cli/help.txt` — regenerated help text (asserted by both `rust/climon-cli/tests/cli_fixtures.rs` and `tests/cli-fixtures.test.ts`).
- `src/cli/args.ts` — mirror `helpText` string change; add `shell` subcommand parsing; no-args and leading-flags-only → `{ command: "help" }`.
- `tests/args.test.ts` — update no-args + leading-flags expectations; add `shell` cases.
- `README.md`, `docs/usage.md` — document `climon shell`.
- `docs/manual-tests/phase08-cli.md` — retarget the bare-`climon` case and add a `climon shell` / implicit-help case; index already lists MT-P8-xx entries.

**Note on TS scope:** The TS `help` variant stays `{ command: "help" }` (no `implicit` field). The Bun server entrypoint (`src/server.ts`) only prints `helpText` on its own error path and never prints the friendly note, so the `implicit` flag is a Rust-only concern.

---

## Task 1: Rust parser — `Help { implicit }`, `shell` subcommand, help text

**Files:**
- Modify: `rust/climon-cli/src/args.rs`

- [ ] **Step 1: Update the failing unit tests first (no-args, help flags, bare-flags)**

In `rust/climon-cli/src/args.rs`, replace the `defaults_to_shell_with_no_args` test (around lines 607–618) with:

```rust
    #[test]
    fn defaults_to_implicit_help_with_no_args() {
        assert_eq!(parse(&[]), ParsedCommand::Help { implicit: true });
    }
```

Replace the `parses_help_flags` test (around lines 620–625) with:

```rust
    #[test]
    fn parses_help_flags() {
        assert_eq!(parse(&["--help"]), ParsedCommand::Help { implicit: false });
        assert_eq!(parse(&["-h"]), ParsedCommand::Help { implicit: false });
        assert_eq!(parse(&["help"]), ParsedCommand::Help { implicit: false });
    }
```

Replace the `bare_flags_with_no_command_defaults_to_shell` test (around lines 916–936) with:

```rust
    #[test]
    fn bare_flags_with_no_command_show_implicit_help() {
        assert_eq!(
            parse(&["--name", "my session"]),
            ParsedCommand::Help { implicit: true }
        );
        assert_eq!(
            parse(&["--priority", "5", "--color", "blue"]),
            ParsedCommand::Help { implicit: true }
        );
    }
```

Add these new tests immediately after `bare_flags_with_no_command_show_implicit_help`:

```rust
    #[test]
    fn parses_shell_subcommand_with_no_flags() {
        assert_eq!(
            parse(&["shell"]),
            ParsedCommand::Shell {
                priority: None,
                color: None,
                name: None,
                theme: None,
            }
        );
    }

    #[test]
    fn parses_shell_subcommand_with_session_flags() {
        assert_eq!(
            parse(&["shell", "--priority", "5", "--color", "blue", "--name", "dev", "--theme", "Dracula"]),
            ParsedCommand::Shell {
                priority: Some(5),
                color: Some(ColorFlag::Color(AnsiColor::Blue)),
                name: Some("dev".to_string()),
                theme: Some("Dracula".to_string()),
            }
        );
    }

    #[test]
    fn shell_subcommand_rejects_a_trailing_command() {
        let err = parse_args(&v(&["shell", "npm", "test"])).unwrap_err();
        assert!(err.contains("does not take a command"), "got: {err}");
    }

    #[test]
    fn help_text_documents_shell_command() {
        let h = help_text(ExperimentalHelp::default());
        assert!(h.contains("climon shell [--priority N]"));
        assert!(h.contains("Start a monitored session for the current shell"));
    }
```

- [ ] **Step 2: Run the tests to confirm they fail to compile / fail**

Run: `cd rust && cargo test -p climon-cli --lib`
Expected: FAIL — `Help` does not take fields (`ParsedCommand::Help { implicit: true }` won't compile), and the `shell`/help-text tests fail.

- [ ] **Step 3: Change the `Help` variant and add the help-text line**

In `rust/climon-cli/src/args.rs`, change the `Help` variant (line 42) from:

```rust
    Help,
```

to:

```rust
    /// `climon --help` / `help` (explicit) or bare `climon` / leading session
    /// flags with no command (implicit). When `implicit`, the launcher prints a
    /// friendly note explaining why help is shown; explicit help does not, so it
    /// stays byte-for-byte identical to `fixtures/cli/help.txt`.
    Help { implicit: bool },
```

In `help_text` (the `format!` block starting at line 146), replace this block:

```
Usage:
  climon [--priority N] [--color C] [--name S] [--theme T]
                               Start a monitored session for the current shell
  climon [--priority N] [--color C] [--name S] [--theme T] <command> [args...]
```

with:

```
Usage:
  climon shell [--priority N] [--color C] [--name S] [--theme T]
                               Start a monitored session for the current shell
  climon [--priority N] [--color C] [--name S] [--theme T] <command> [args...]
```

- [ ] **Step 4: Update `parse_args` — no-args, leading-flags, help flags, and the `shell` arm**

In `parse_args`, change the empty-argv branch (lines 309–316) from:

```rust
    if argv.is_empty() {
        return Ok(ParsedCommand::Shell {
            priority: None,
            color: None,
            name: None,
            theme: None,
        });
    }
```

to:

```rust
    if argv.is_empty() {
        return Ok(ParsedCommand::Help { implicit: true });
    }
```

Change the leading-flags branch (lines 326–331) from:

```rust
        let (flags, rest) = parse_session_flags(argv)?;
        if rest.is_empty() {
            return Ok(shell_from_flags(flags));
        }
        return Ok(run_from_flags(rest, false, flags));
```

to:

```rust
        let (flags, rest) = parse_session_flags(argv)?;
        if rest.is_empty() {
            // Session flags with no command no longer start a shell; a shell now
            // requires the explicit `climon shell`. Fall through to help.
            let _ = flags;
            return Ok(ParsedCommand::Help { implicit: true });
        }
        return Ok(run_from_flags(rest, false, flags));
```

Change the help match arm (line 336) from:

```rust
        "help" | "--help" | "-h" => Ok(ParsedCommand::Help),
```

to:

```rust
        "help" | "--help" | "-h" => Ok(ParsedCommand::Help { implicit: false }),
```

Add a `shell` arm. Insert it immediately after the `"ls" | "list" => Ok(ParsedCommand::Ls),` arm (line 359):

```rust
        "shell" => {
            let (flags, extra) = parse_session_flags(&rest)?;
            if !extra.is_empty() {
                return Err(
                    "`climon shell` does not take a command; use `climon <command>` to run one."
                        .to_string(),
                );
            }
            Ok(shell_from_flags(flags))
        }
```

- [ ] **Step 5: Run the parser unit tests to confirm they pass**

Run: `cd rust && cargo test -p climon-cli --lib`
Expected: PASS. (The `cli_fixtures` integration test is NOT run by `--lib`; it is fixed in Task 3.)

- [ ] **Step 6: Commit**

```bash
git add rust/climon-cli/src/args.rs
git commit -m "feat(cli): add climon shell command; bare climon parses to implicit help

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Rust dispatch — friendly note on implicit help

**Files:**
- Modify: `rust/climon-cli/src/main.rs`

- [ ] **Step 1: Update the `command_name` `Help` pattern**

In `rust/climon-cli/src/main.rs`, change (line 420):

```rust
        ParsedCommand::Help => "help",
```

to:

```rust
        ParsedCommand::Help { .. } => "help",
```

- [ ] **Step 2: Update the `Help` dispatch arm to print the friendly note when implicit**

In `main.rs`, change the `Help` arm (lines 86–97) from:

```rust
        ParsedCommand::Help => {
            let cfg_env = ConfigEnv::real();
            let experimental = climon_config::config::load_config(&cfg_env)
                .map(|cfg| climon_cli::args::ExperimentalHelp {
                    remotes: climon_config::features::is_feature_enabled(&cfg, "remotes")
                        || climon_config::features::is_feature_enabled(&cfg, "wslBridge"),
                    wsl_bridge: climon_config::features::is_feature_enabled(&cfg, "wslBridge"),
                })
                .unwrap_or_default();
            write_stdout(&help_text(experimental), false);
            Ok(0)
        }
```

to:

```rust
        ParsedCommand::Help { implicit } => {
            let cfg_env = ConfigEnv::real();
            let experimental = climon_config::config::load_config(&cfg_env)
                .map(|cfg| climon_cli::args::ExperimentalHelp {
                    remotes: climon_config::features::is_feature_enabled(&cfg, "remotes")
                        || climon_config::features::is_feature_enabled(&cfg, "wslBridge"),
                    wsl_bridge: climon_config::features::is_feature_enabled(&cfg, "wslBridge"),
                })
                .unwrap_or_default();
            if implicit {
                write_stderr(
                    "climon on its own no longer starts a session — showing help instead.\nUse `climon shell` to start a monitored shell, or `climon <command>` to run a command.\n\n",
                    false,
                );
            }
            write_stdout(&help_text(experimental), false);
            Ok(0)
        }
```

`write_stderr` is already imported (line 21) — no new imports needed.

- [ ] **Step 3: Build to confirm the crate compiles**

Run: `cd rust && cargo build -p climon-cli`
Expected: builds successfully (no non-exhaustive-match or missing-field errors).

- [ ] **Step 4: Manually verify the runtime behavior**

Run:
```bash
cd rust
CLIMON_HOME=$(mktemp -d) cargo run -q -p climon-cli -- 2>/tmp/climon-note.txt >/tmp/climon-help.txt; \
echo "--- stderr note ---"; cat /tmp/climon-note.txt; \
echo "--- stdout help head ---"; head -6 /tmp/climon-help.txt
```
Expected: `/tmp/climon-note.txt` contains the two-line note; `/tmp/climon-help.txt` starts with the version line and the `climon shell [--priority N] …` usage line.

Then confirm explicit help prints NO note:
```bash
CLIMON_HOME=$(mktemp -d) cargo run -q -p climon-cli -- --help 2>/tmp/climon-note2.txt >/dev/null; \
echo "--- stderr (should be empty) ---"; cat /tmp/climon-note2.txt
```
Expected: `/tmp/climon-note2.txt` is empty.

- [ ] **Step 5: Commit**

```bash
git add rust/climon-cli/src/main.rs
git commit -m "feat(cli): print friendly note before implicit help output

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Regenerate the shared help fixture

**Files:**
- Modify: `fixtures/cli/help.txt`
- Test: `rust/climon-cli/tests/cli_fixtures.rs` (existing; no edit)

- [ ] **Step 1: Run the fixture integration test to confirm it currently fails**

Run: `cd rust && cargo test -p climon-cli --test cli_fixtures help_output_matches_fixture`
Expected: FAIL — the binary now emits `climon shell …` but the fixture still has the old first usage line.

- [ ] **Step 2: Update the fixture's first usage line**

In `fixtures/cli/help.txt`, replace this block (lines 4–5):

```
  climon [--priority N] [--color C] [--name S] [--theme T]
                               Start a monitored session for the current shell
```

with:

```
  climon shell [--priority N] [--color C] [--name S] [--theme T]
                               Start a monitored session for the current shell
```

Leave the rest of the file (including the `climon [--priority N] … <command> [args...]` run line and the trailing newline) unchanged.

- [ ] **Step 3: Run the fixture integration tests to confirm they pass**

Run: `cd rust && cargo test -p climon-cli --test cli_fixtures`
Expected: PASS — both `help_output_matches_fixture` and `version_output_matches_fixture`.

- [ ] **Step 4: Commit**

```bash
git add fixtures/cli/help.txt
git commit -m "chore(cli): regenerate help fixture for climon shell command

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Update the TypeScript mirror (`src/cli/args.ts`) and its tests

**Files:**
- Modify: `src/cli/args.ts`
- Test: `tests/args.test.ts`

- [ ] **Step 1: Update the failing TS tests first**

In `tests/args.test.ts`, replace the `defaults to shell with no args` test (lines 21–23) with:

```ts
  test("defaults to help with no args", () => {
    expect(parseArgs([])).toEqual({ command: "help" });
  });
```

Replace the `bare flags with no command defaults to shell` test (lines 155–165) with:

```ts
  test("bare flags with no command fall through to help", () => {
    expect(parseArgs(["--name", "my session"])).toEqual({ command: "help" });
    expect(parseArgs(["--priority", "5", "--color", "blue"])).toEqual({ command: "help" });
  });

  test("parses the shell subcommand with session flags", () => {
    expect(parseArgs(["shell"])).toEqual({ command: "shell" });
    expect(parseArgs(["shell", "--priority", "5", "--color", "blue", "--name", "dev"])).toEqual({
      command: "shell",
      priority: 5,
      color: "blue",
      name: "dev"
    });
  });

  test("shell subcommand rejects a trailing command", () => {
    expect(() => parseArgs(["shell", "npm", "test"])).toThrow(/does not take a command/);
  });
```

- [ ] **Step 2: Run the TS tests to confirm they fail**

Run: `bun test tests/args.test.ts`
Expected: FAIL — `parseArgs([])` still returns `{ command: "shell" }`, and there is no `shell` subcommand handling.

- [ ] **Step 3: Update `helpText` in `src/cli/args.ts`**

In `src/cli/args.ts`, replace this block (lines 38–39):

```ts
  climon [--priority N] [--color C] [--name S] [--theme T]
                               Start a monitored session for the current shell
```

with:

```ts
  climon shell [--priority N] [--color C] [--name S] [--theme T]
                               Start a monitored session for the current shell
```

- [ ] **Step 4: Update `parseArgs` in `src/cli/args.ts`**

Change the empty-argv branch (lines 113–115) from:

```ts
  if (argv.length === 0) {
    return { command: "shell" };
  }
```

to:

```ts
  if (argv.length === 0) {
    return { command: "help" };
  }
```

Change the leading-flags branch (lines 119–126) from:

```ts
  if (argv[0].startsWith("--") && !["--help", "-h", "--version", "-v", "--update"].includes(argv[0])) {
    const { flags, rest } = parseSessionFlags(argv);
    if (rest.length === 0) {
      return { command: "shell", ...flags };
    }
    // If there are remaining tokens, treat as `run`
    return { command: "run", argv: rest, headless: false, ...flags };
  }
```

to:

```ts
  if (argv[0].startsWith("--") && !["--help", "-h", "--version", "-v", "--update"].includes(argv[0])) {
    const { flags, rest } = parseSessionFlags(argv);
    if (rest.length === 0) {
      // Session flags with no command no longer start a shell; a shell now
      // requires the explicit `climon shell`. Fall through to help.
      void flags;
      return { command: "help" };
    }
    // If there are remaining tokens, treat as `run`
    return { command: "run", argv: rest, headless: false, ...flags };
  }
```

Add a `shell` case in the `switch (first)` block, immediately after the `case "list": return { command: "ls" };` arm (lines 165–167):

```ts
    case "shell": {
      const { flags, rest: extra } = parseSessionFlags(rest);
      if (extra.length > 0) {
        throw new Error("`climon shell` does not take a command; use `climon <command>` to run one.");
      }
      return { command: "shell", ...flags };
    }
```

- [ ] **Step 5: Run the TS args + fixture tests to confirm they pass**

Run: `bun test tests/args.test.ts tests/cli-fixtures.test.ts`
Expected: PASS — the `shell`/help changes pass, and `helpText` matches the fixture updated in Task 3.

- [ ] **Step 6: Type-check the TS project**

Run: `bun run typecheck`
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/cli/args.ts tests/args.test.ts
git commit -m "feat(server): mirror climon shell command + help-on-no-args in TS parser

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Documentation and manual tests

**Files:**
- Modify: `README.md`
- Modify: `docs/usage.md`
- Modify: `docs/manual-tests/phase08-cli.md`

- [ ] **Step 1: Document `climon shell` in `README.md`**

In `README.md`, immediately after the `### \`climon <command> [args...]\`` section (i.e. after line 154, before the "Tag a session at launch…" paragraph on line 156), insert:

```markdown
### `climon shell`

Start a monitored session running your current shell (PowerShell on Windows). This
is what a bare `climon` used to do; run it explicitly to launch a shell inside a
climon session.

```sh
climon shell                 # monitor the detected parent shell
climon shell --name "work"   # …with a friendly name
```

Running `climon` with no command now prints this help.

```

- [ ] **Step 2: Document `climon shell` in `docs/usage.md`**

In `docs/usage.md`, immediately after the "Monitor a command" section's first code block (after line 33, before the "You can give the session its own dashboard terminal theme…" paragraph on line 39), insert:

```markdown
To monitor an interactive shell without naming a command, use `climon shell`:

```bash
climon shell
```

This launches your detected parent shell (PowerShell on Windows) in a managed PTY.
Running `climon` with no arguments prints the help text instead of starting a
shell.

```

- [ ] **Step 3: Retarget the bare-`climon` manual test**

In `docs/manual-tests/phase08-cli.md`, in the `MT-P8-03` case, change the title from:

```
## MT-P8-03 — bare `climon` starts a monitored shell session
```

to:

```
## MT-P8-03 — `climon shell` starts a monitored shell session
```

and change step 1 from:

```
1. From an interactive shell, run `climon` with no args.
```

to:

```
1. From an interactive shell, run `climon shell`.
```

Leave the remaining steps and the Expected block unchanged (they still describe a monitored shell session).

- [ ] **Step 4: Add a manual test for bare `climon` → help**

In `docs/manual-tests/phase08-cli.md`, immediately after the `MT-P8-03` result-tracking table and its `---` separator, insert a new case (adjust nothing else):

```markdown
## MT-P8-05 — bare `climon` prints a friendly note and help

- **ID:** MT-P8-05
- **Preconditions:** `export CLIMON_HOME=$(mktemp -d)` (PowerShell: set
  `$env:CLIMON_HOME`).
- **Config-matrix cell:** CLI-linux / CLI-macos / CLI-win
- **Platforms:** all

**Steps:**
1. Run `climon` with no arguments.
2. Run `climon --priority 5` (session flags, no command).
3. Run `climon --help` and compare its output.

**Expected:** Steps 1 and 2 print a two-line note to stderr
(`climon on its own no longer starts a session — showing help instead.` / `Use
\`climon shell\` …`) followed by the full help text on stdout; no session is
started. Step 3 prints the same help text on stdout with **no** note on stderr.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---
```

If the file has an index/table of contents listing MT-P8-xx entries near the top, add an `MT-P8-05` line there matching the existing format.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/usage.md docs/manual-tests/phase08-cli.md
git commit -m "docs: document climon shell command and bare-climon help behavior

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full Rust test suite for the CLI crate**

Run: `cd rust && cargo test -p climon-cli`
Expected: PASS (unit tests + `cli_fixtures` integration tests).

- [ ] **Step 2: Clippy and fmt**

Run: `cd rust && cargo clippy -p climon-cli --all-targets -- -D warnings && cargo fmt --check`
Expected: no warnings; formatting clean. (If `cargo fmt --check` reports diffs, run `cargo fmt` and amend the relevant commit.)

- [ ] **Step 3: Run the Bun args + fixture tests**

Run: `bun test tests/args.test.ts tests/cli-fixtures.test.ts`
Expected: PASS.

- [ ] **Step 4: Confirm no stray references to the old bare-`climon`-starts-shell behavior**

Run: `grep -rn "climon\` with no args\|bare \`climon\` starts" README.md docs/ | grep -v superpowers`
Expected: no results describing bare `climon` as starting a shell (only the new help behavior and `climon shell`).
