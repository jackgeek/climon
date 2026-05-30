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
- **Live web terminal.** The dashboard is a React + Fluent UI app that embeds an
  `xterm.js` terminal wired to the session over a WebSocket — fully interactive,
  no iframe.
- **Attention queue.** While a session is attached locally, climon mirrors its
  output into a headless terminal and watches the rendered screen. If the visible
  content stops changing for `attention.idleSeconds` (default 10) — a blinking
  cursor counts as static — the session is flagged and bumped to the top of the
  dashboard.
- **Completion pops.** Finished sessions move up the queue and keep their final
  scrollback so you can review the output.

## Requirements

- [Bun](https://bun.sh) >= 1.3.0 (native PTY support is required).

## Quick start

```bash
bun run build:all            # bundle the client and the server
bun link                     # make `climon` and `climon-server` available globally
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

Once the server is running you can also start new sessions directly from the
dashboard. Session creation is **per-session**: hover any live session
(`running`, `needs-attention`, or `disconnected`) and click its **[+]** button to
launch a new session from it. The server spawns the new session directly,
inheriting the selected session's working directory, so you are prompted only for
the command. Because this no longer depends on an attached terminal, you can
launch a session from any live session — including ones that were themselves
spawned this way (arbitrary nesting).

When there are **no** sessions at all, a global **[+]** appears in the
sidebar header instead. It asks the dashboard server to spawn a session for you
(prompting for a command and optional working directory); the server does this by
invoking the `climon` client binary — looked up via `CLIMON_CLIENT_BIN`, then a
sibling binary next to `climon-server`, then your `PATH`. For security, all
creation only works from the machine running the server (loopback); remote/LAN
clients cannot create sessions.

The client and dashboard server ship as two binaries: a lean `climon` (client) and
`climon-server` (dashboard). Running `climon server` locates and runs `climon-server`
— looked up via `CLIMON_SERVER_BIN`, then a sibling binary next to `climon`, then your
`PATH`. The dashboard is a React + Fluent UI single-page app (`src/web/`) bundled and
embedded into `climon-server`; keeping it out of `climon` means client-only usage stays
small as the server grows.

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
| `climon-linux-x64` / `climon-server-linux-x64` | Linux x86_64 |
| `climon-linux-arm64` / `climon-server-linux-arm64` | Linux aarch64 |
| `climon-darwin-x64` / `climon-server-darwin-x64` | macOS Intel |
| `climon-darwin-arm64` / `climon-server-darwin-arm64` | macOS Apple Silicon |

Each binary is fully standalone — copy it to the target machine and run it
directly. No Bun installation or `node_modules` needed. Install both the `climon`
(client) and `climon-server` binaries side by side so `climon server` can find and
launch the dashboard.

## Releasing

The version lives in `package.json` and is the single source of truth: both
binaries and the dashboard read it via `src/version.ts`, so a bump flows
everywhere on the next build.

Bump it with the release script, which rewrites `package.json`, commits the
change, and creates a matching `vX.Y.Z` git tag:

```bash
bun run release            # patch bump (default): 0.1.0 -> 0.1.1
bun run release minor      # 0.1.0 -> 0.2.0
bun run release major      # 0.1.0 -> 1.0.0
```

The script refuses to run with a dirty working tree (so the release commit only
contains the bump) and does **not** push — finish with `git push --follow-tags`.

### Automatic bump on merge to `main`

A husky `post-merge` hook (installed via the `prepare` script on `bun install`)
runs a patch release automatically when a feature branch is merged into `main`.
Because Git hooks are local and there is no native "merged to main" event, the
hook is deliberately conservative — it only bumps when:

- the current branch is `main`, **and**
- the merge created a real merge commit (so fast-forward `git pull`s of an
  already-bumped `main` never double-bump).

Notes:

- Merge feature branches into `main` with a merge commit (`git merge --no-ff`, or
  GitHub's "Create a merge commit") so the hook fires; pure fast-forward merges
  are intentionally skipped.
- Server-side PR merges (squash/rebase on GitHub) don't run local hooks; the
  bump then happens for whoever next integrates `main` with a merge commit.
- Set `CLIMON_SKIP_RELEASE=1` to opt out for a given merge.
- The bump is committed and tagged locally only; push with `git push --follow-tags`.

## Further reading

See [`docs/setup.md`](docs/setup.md), [`docs/usage.md`](docs/usage.md),
[`docs/architecture.md`](docs/architecture.md), and
[`docs/troubleshooting.md`](docs/troubleshooting.md) for details.
