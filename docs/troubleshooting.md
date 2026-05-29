# Troubleshooting

## `climon: command not found`

You haven't linked the CLI. Either run it directly with `bun src/index.ts ...`
or run `bun link` in the project root to get a global `climon` command. Ensure
`~/.bun/bin` is on your `PATH`.

## The web terminal is blank / black

If the web terminal renders as a blank or black box:

1. Confirm the session is **running** (live sessions stream over WebSocket;
   completed sessions show saved scrollback).
2. Check the browser console for asset errors — `/assets/xterm.js`,
   `/assets/xterm.css`, `/assets/addon-fit.js` must load. If they 404, run
   `bun install` so the `@xterm/*` packages are present.
3. Make sure you can reach the server (correct host/port; on LAN add `?token=`).

## A session is stuck on `running` and shows no output

The daemon logs to `~/.climon/sessions/<id>.log`. Inspect it:

```bash
cat "$CLIMON_HOME/sessions/<id>.log"   # CLIMON_HOME defaults to ~/.climon
```

Common causes:

- **Bun too old.** Native PTY requires Bun >= 1.3. Run `bun --version`. On older
  Bun, PTY output is lost almost immediately. Upgrade Bun.
- **Command not found.** If the launched executable doesn't exist, the daemon
  exits quickly; the log shows the error and the session becomes `failed`.

## Sessions disappear after a reboot

This is expected. Sessions survive **server** restarts (the daemon owns the PTY),
but not a full host reboot — daemons are normal processes and stop when the
machine restarts.

## Can't connect from another machine

LAN access is off by default. Start the server with `--lan` and append the
printed `?token=<token>` to the URL. Without `--lan`, only `127.0.0.1`/`::1` are
allowed.

## Windows: interactive sessions don't work

Bun's PTY (`Bun.Terminal`) is POSIX-only. On Windows, run climon inside **WSL**
for the interactive PTY experience.

## Cleaning up stale state

Session metadata and sockets live under `$CLIMON_HOME` (default `~/.climon`). If
you have orphaned entries from killed processes, you can remove
`~/.climon/sessions/*` and `~/.climon/sock/*`. Use `climon kill <id>` to stop a
session and clear its metadata properly.

## Resetting the access token

Delete `~/.climon/config.json` (a new one with a fresh token is generated on next
start), or rotate it programmatically via the `rotateToken` helper in
`src/config.ts`.
