# climon

A web-based monitor for interactive CLI sessions. Prefix any command with
`climon` to run it inside a managed pseudo-terminal; a local dashboard lists all
monitored sessions, surfaces the ones that need your attention, and lets you
interact with each one from the browser.

## Highlights

- **No external dependencies.** Uses Bun's built-in PTY (`Bun.Terminal`) and
  HTTP/WebSocket server. Runs natively on Linux, macOS, and Windows — on
  Windows the PTY layer uses ConPTY via Bun's native terminal.
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
- **Remote clients over hardened SSH.** Monitor sessions running on another
  machine from your local dashboard. Traffic rides a single OpenSSH connection
  (no tunneled ports, host-key pinning, forced-command containment). See
  [docs/security.md](docs/security.md).

## Requirements

- [Bun](https://bun.sh) >= 1.3.0 on Linux/macOS, or >= 1.3.14 on Windows
  (native ConPTY support is required).

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

You can also tag a session at launch with organizing metadata, placed **before**
the command:

```bash
climon --priority 100 --color red --name "dev server" npm run dev
```

- `--priority N` — an integer `0–1000` (default `500`) controlling sort order in
  the dashboard and `climon ls`; lower sorts to the top.
- `--color C` — one of `black`, `red`, `green`, `yellow`, `blue`, `magenta`,
  `cyan`, `white` (or `none`); shown as a colored accent on the session.
- `--name S` — a friendly label shown instead of the command.

All three can also be set or changed from the dashboard by clicking the **cog**
button on a session. Sessions spawned from another session (the **[+]** button)
inherit its priority and color.

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

This outputs per-platform zip archives to `dist/`:

| File | Platform | Contents |
| --- | --- | --- |
| `climon-linux-x64.zip` | Linux x86_64 | `climon`, `climon-server` |
| `climon-linux-arm64.zip` | Linux aarch64 | `climon`, `climon-server` |
| `climon-darwin-x64.zip` | macOS Intel | `climon`, `climon-server` |
| `climon-darwin-arm64.zip` | macOS Apple Silicon | `climon`, `climon-server` |
| `climon-windows-x64.zip` | Windows x86_64 | `climon.exe`, `climon-server.exe` |

Each binary is fully standalone — no Bun installation or `node_modules` needed.
Unzip the archive for your platform and place both binaries side by side (the
`climon` client locates `climon-server` as a sibling). On Linux and macOS the
extracted binaries keep their executable bit; on Windows use `climon.exe`.

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

The patch bump runs automatically in CI whenever `main` is updated — i.e. when a
pull request is merged. The [`Release`](.github/workflows/release.yml) workflow
checks out `main`, runs `bun run release`, and pushes the bump commit and tag
back to `main`.

Notes:

- Works for **every** merge style — merge commit, squash, or rebase — because it
  triggers on any push to `main`, not on a local Git hook.
- The release commit message starts with `chore(release):`, and the workflow
  skips those, so the bump it pushes never triggers another bump.
- The workflow pushes with `GITHUB_TOKEN`, which works because `main` is not a
  protected branch. If you later protect `main` against direct pushes, the bot
  token can only bypass it on **organization** repositories; on a user-owned
  repo you must supply an **admin-owned** PAT with `contents: write` as the
  `RELEASE_TOKEN` secret (the workflow prefers it when present).
- To cut a `minor`/`major` release instead, run `bun run release minor|major`
  locally and push with `git push --follow-tags`.

## Further reading

See [`docs/setup.md`](docs/setup.md), [`docs/usage.md`](docs/usage.md),
[`docs/architecture.md`](docs/architecture.md), and
[`docs/troubleshooting.md`](docs/troubleshooting.md) for details.
