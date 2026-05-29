# climon

A web-based monitor for interactive CLI sessions. Prefix any command with
`climon` to run it inside a managed pseudo-terminal; a local dashboard lists all
monitored sessions, surfaces the ones that need your attention, and lets you
interact with each one from the browser.

```
climon copilot          # run `copilot` in a monitored PTY session
climon server           # start the dashboard (http://127.0.0.1:3131)
climon ls               # list sessions
climon attach <id>      # reattach to a running session
climon kill <id>        # terminate a session
```

## Highlights

- **No external dependencies.** Uses Bun's built-in PTY (`Bun.Terminal`) and
  HTTP/WebSocket server — no tmux, no ttyd. Runs on Linux and macOS natively; on
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
bun install
bun src/index.ts server      # terminal 1: dashboard
bun src/index.ts copilot     # terminal 2: a monitored command
```

Open http://127.0.0.1:3131 and click a session.

See [`docs/setup.md`](docs/setup.md), [`docs/usage.md`](docs/usage.md),
[`docs/architecture.md`](docs/architecture.md), and
[`docs/troubleshooting.md`](docs/troubleshooting.md) for details.
