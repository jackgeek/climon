# climon

A web-based monitor for interactive CLI sessions. Prefix any command with
`climon` to run it inside a managed pseudo-terminal; a local dashboard lists all
monitored sessions, surfaces the ones that need your attention, and lets you
interact with each one from the browser.

## Highlights

- **No external dependencies.** Uses Bun's built-in PTY (`Bun.Terminal`) and
  HTTP/WebSocket server. Runs on Linux and macOS natively; on
  Windows, run it under WSL (the PTY layer is POSIX-only).
- **Sessions survive server restarts.** Each command runs under its own detached
  per-session daemon that owns the PTY. Restarting `climon server` never kills a
  session.
- **Live web terminal.** The dashboard embeds an `xterm.js` terminal wired to the
  session over a WebSocket — fully interactive, no iframe.
- **Attention queue.** When a session prints a prompt (e.g. "continue?", "[y/n]",
  "waiting for input"), it is flagged and bumped to the top of the dashboard.
- **Completion pops.** Finished sessions move up the queue and keep their final
  scrollback so you can review the output.

## Requirements

- [Bun](https://bun.sh) >= 1.3.0 (native PTY support is required).

## Quick start

```bash
bun build                    # compile the CLI
bun link                     # make `climon` available globally
climon server                # terminal 1: start the dashboard
```

Then in a new terminal:

```bash
climon bash                  # run any command in a monitored session
```

Open http://127.0.0.1:3131 and click a session.

## Commands

### `climon <command> [args...]`

Run any command inside a monitored PTY session. Use this whenever you want to
launch a long-running or interactive process (a build, a REPL, a coding agent)
and be able to check on it later from the web dashboard without keeping the
terminal window open.

```bash
climon bash                  # monitor an interactive shell
climon copilot               # monitor a coding agent session
climon npm run dev           # monitor a dev server
```

### `climon server [--lan] [--port N]`

Start the web dashboard. This serves the UI at http://127.0.0.1:3131 and
connects to all running session daemons via WebSocket. Use this when you want to
view, interact with, or manage your monitored sessions from a browser.

- `--lan` — bind to `0.0.0.0` so other machines on the network can access the
  dashboard.
- `--port N` — use a custom port instead of the default `3131`.

### `climon ls`

List all monitored sessions with their IDs, status, and the command that was
run. Use this to find the session ID you need for `attach` or `kill`, or to
quickly check which sessions are still running.

### `climon attach <id>`

Reattach your terminal to a running session. Use this when you want to interact
directly with a monitored process from the command line (instead of the web UI),
for example to type into a REPL or respond to a prompt.

Detach without stopping the command using: `Ctrl-\` then `d`.

### `climon kill <id>`

Terminate a monitored session and its underlying process. Use this to clean up
sessions you no longer need — finished builds, abandoned REPLs, or any process
you want to stop.

## Building standalone binaries

To produce self-contained executables that run without Bun or this repository:

```bash
bun install                  # ensure dependencies are present
bun run compile              # builds for all platforms
```

This outputs binaries to `dist/`:

| File | Platform |
|------|----------|
| `climon-linux-x64` | Linux x86_64 |
| `climon-linux-arm64` | Linux aarch64 |
| `climon-darwin-x64` | macOS Intel |
| `climon-darwin-arm64` | macOS Apple Silicon |

Each binary is fully standalone — copy it to the target machine and run it
directly. No Bun installation or `node_modules` needed.

## Further reading

See [`docs/setup.md`](docs/setup.md), [`docs/usage.md`](docs/usage.md),
[`docs/architecture.md`](docs/architecture.md), and
[`docs/troubleshooting.md`](docs/troubleshooting.md) for details.
