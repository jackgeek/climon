# Design: `climon shell` command + bare `climon` shows help

## Problem

Today, running `climon` with no arguments detects the current shell and starts a
monitored session for a newly launched shell. This makes the bare invocation a
"do something" command rather than a discoverable entrypoint. We want:

- `climon` (no arguments) to behave exactly like `climon --help`.
- A new explicit `climon shell` command that starts a monitored session for the
  current shell (the behavior bare `climon` has today).

## Current behavior (baseline)

Argument parsing lives in the Rust client `rust/climon-cli/src/args.rs`
(`parse_args`), mirrored byte-for-byte by the TypeScript `src/cli/args.ts`
(`parseArgs`). The TS mirror is still consumed by the Bun dashboard server
entrypoint (`src/server.ts`) to detect the `server` command and to print help on
error, so both must stay in sync. A shared golden fixture
`fixtures/cli/help.txt` is asserted byte-for-byte by both
`rust/climon-cli/tests/cli_fixtures.rs` and `tests/cli-fixtures.test.ts`.

Three paths currently reach shell mode:

1. `climon` (no args) → `Shell`.
2. `climon --priority 5` / `--color` / `--name` / `--theme` with no trailing
   command (leading session flags only) → `Shell`.
3. `climon <command> [args...]` and `climon --priority 5 npm test` → `Run`
   (unchanged by this work).

## Target behavior

1. **No args** (`climon`) → implicit `Help` (with the friendly note; see below).
2. **New `shell` subcommand**: `climon shell [--priority N] [--color C]
   [--name S] [--theme T]` → `Shell{...}` with the parsed session flags. Trailing
   non-flag arguments (e.g. `climon shell npm test`) are an **error** that
   directs the user to `climon <command>` for running a command.
3. **Leading session flags with no command** (e.g. `climon --priority 5`) →
   fall through to implicit `Help` (with the friendly note). (Previously started
   a shell; now the explicit `climon shell` is required.)
4. **`climon <command>` / `climon --priority 5 npm test`** → `Run` (unchanged).

## Friendly implicit-help note

Because this is a behavior change, when help is shown *implicitly* (cases 1 and
3 above — bare `climon`, or leading session flags with no command) the client
first prints a friendly note explaining why. An *explicit* `climon --help` /
`climon help` must NOT print the note — its output stays byte-for-byte identical
to `fixtures/cli/help.txt`.

The note is written to **stderr** (so piping the help text stays clean), then the
normal help text is written to **stdout**:

```
climon on its own no longer starts a session — showing help instead.
Use `climon shell` to start a monitored shell, or `climon <command>` to run a command.
```

To distinguish the two paths, the parser marks implicit help. The Rust
`ParsedCommand::Help` gains a boolean field (e.g. `Help { implicit: bool }`);
`main.rs` prints the note only when `implicit` is true. The TS `parseArgs`
mirrors this with an `implicit` flag on the `help` command, but since the server
entrypoint only prints `helpText` on an *error* path (never the implicit note),
the TS change is limited to keeping the parsed shape and help text in sync.

## Help text change

Replace the first usage line. The bare-`climon` shell line becomes an explicit
`climon shell` line; the run line is unchanged:

```
  climon shell [--priority N] [--color C] [--name S] [--theme T]
                               Start a monitored session for the current shell
  climon [--priority N] [--color C] [--name S] [--theme T] <command> [args...]
                               Run a command in a monitored PTY session
```

## Files touched

- `rust/climon-cli/src/args.rs` — add `shell` parsing; no-args → implicit
  `Help`; leading-flags-only → implicit `Help`; `Help` carries an `implicit`
  flag; update `help_text`; update unit tests.
- `rust/climon-cli/src/main.rs` — print the friendly note to stderr when `Help`
  is implicit.
- `src/cli/args.ts` — mirror the same parsing (incl. the `implicit` flag) and
  `helpText` change (keeps the server entrypoint and the shared fixture in sync).
- `fixtures/cli/help.txt` — regenerate to match the new help text.
- `tests/args.test.ts` — update the no-args expectation and add `shell` cases.
- `docs/manual-tests/phase08-cli.md` — update the step that runs bare `climon`,
  and add a manual-test case for `climon shell` and for bare `climon` → help.
- `README.md` / `docs/usage.md` — update any text that says bare `climon` starts
  a shell; document `climon shell`.

## Dispatch

`rust/climon-cli/src/main.rs` already dispatches `ParsedCommand::Shell` (detect
parent shell, build shell argv, start monitored command). The `Help` arm gains a
small change: when `implicit` is true it writes the friendly note to stderr
before writing the help text to stdout. The `command_name` mapping already
returns `"shell"` for `Shell` and `"help"` for `Help`.

## Testing

- Rust: `cargo test` in `rust/` (unit tests in `args.rs` + `cli_fixtures.rs`
  golden fixture); `cargo clippy --all-targets`; `cargo fmt`.
- Bun: `bun test tests/args.test.ts tests/cli-fixtures.test.ts`.
- Manual: the new/updated cases in `docs/manual-tests/phase08-cli.md`.

## Out of scope

- No change to the `Run` path, session-flag parsing semantics, or any other
  subcommand.
- No change to shell detection (`detect_parent_shell` / `build_shell_argv`).
