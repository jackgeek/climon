# Troubleshooting

## `climon: command not found`

climon isn't on your `PATH`. Install it with the one-liner from the
[README](../README.md#install) (which runs the bundled self-installer and sets up
your `PATH`), then open a new shell. For local development from a source checkout,
run the Rust client with `bun dev -- <args>` (which builds `climon-cli` and runs
the freshly built binary).

## The web terminal is blank / black

If the web terminal renders as a blank or black box:

1. Confirm the session is **running** (live sessions stream over WebSocket;
   completed sessions show saved scrollback).
2. Check the browser console for asset errors — `/assets/app.js` and
   `/assets/xterm.css` must load. These are embedded in `climon-server`; if they
   404, the server build is incomplete (rebuild with `bun run build:server`).
3. Make sure you can reach the server (correct host/port).

## A session is stuck on `running` and shows no output

The daemon logs to `~/.climon/sessions/<id>.log`. Inspect it:

```bash
cat "$CLIMON_HOME/sessions/<id>.log"   # CLIMON_HOME defaults to ~/.climon
```

Common causes:

- **Command not found.** If the launched executable doesn't exist, the daemon
  exits quickly; the log shows the error and the session becomes `failed`.
- **Server too old (dashboard).** The Bun `climon-server` requires Bun >= 1.3 to
  build/run; the native Rust client uses its own portable PTY layer.

## Sessions disappear after a reboot

This is expected. Sessions survive **server** restarts (the daemon owns the PTY),
but not a full host reboot — daemons are normal processes and stop when the
machine restarts.

## Can't connect from another machine

The dashboard server binds to loopback (`127.0.0.1`/`::1`) by design, and you
should keep it that way. climon's security model assumes the dashboard is only
reachable from the local machine — anyone who can reach the port can take over
your sessions, so **do not** bind it to a public interface (e.g.
`server.host 0.0.0.0`).

To use the dashboard from another computer or your phone, use **Tunnel Link**
(the ☰ menu → **Tunnel Link**): it exposes your local dashboard over an
authenticated Microsoft dev tunnel that is private to your account and can't be
shared. Install it as a PWA and you can even receive push notifications when a
session needs attention.

To surface sessions running on a *remote* machine, use the dev tunnels
integration (the **Remotes…** menu, with `feature.remotes` enabled) or the
direct Windows/WSL bridge (`climon link`). These remote features are
**experimental and still under development** — enable them at your own risk. See
`docs/usage.md` for details on remote session access.

## Remote dev tunnel sessions do not appear

Run the diagnostics script on each side and compare where the chain breaks. The
scripts are read-only and redact tunnel tokens.

On the home server:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\diagnostics\Collect-ClimonHomeDiagnostics.ps1
```

On the devbox:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\diagnostics\Collect-ClimonDevboxDiagnostics.ps1
```

Add `-Json` to either command if you want structured output to share or diff.

## Dev Tunnels errors (Tunnel Link and remotes)

**Tunnel Link is always present** in the dashboard's ☰ menu, even when Dev
Tunnels isn't ready. If the tunnel can't start, the Tunnel Link dialog shows a
classified failure — a short summary, an error **code**, remediation, and a
**Retry** button — instead of hiding the entry. The same failures surface for
remote ingest/uplink sessions.

Common cases and what climon does (and does **not**) do for you:

- **`devtunnel` CLI missing (`cli_missing`).** Install Microsoft's `devtunnel`
  CLI following the [linked Dev Tunnels install
  instructions](../README.md#optional-the-devtunnel-cli). climon **will not**
  install it for you. After installing, click **Retry**.
- **Not signed in (`not_authenticated`).** Sign in **manually** by running
  `devtunnel user login`, then click **Retry**. climon never auto-logs-in and
  never launches the sign-in for you.
- **Tunnel limit reached (`tunnel_quota_exhausted`).** Remove unused tunnels
  **manually** with `devtunnel list` and `devtunnel delete`. climon **will not**
  delete any tunnels for you.
- **Rate limits / service or network outages (transient).** climon retries
  automatically with capped-exponential backoff (1s → 30s) and a **Retry now**
  action; the local (loopback) dashboard stays available while it retries.

To inspect status from the terminal, run `climon remotes`: it shows a friendly
failure summary with its code, remediation, and retry state (`retry: paused`
for failures that need you to act, or the next retry time for transient ones).
Add `--json` for the full technical detail and normalized health.

The local dashboard still binds to loopback only — the same security warning in
[Can't connect from another machine](#cant-connect-from-another-machine)
applies; only the authenticated dev tunnel exposes it, and only to your account.

## Cleaning up stale state

Session metadata and sockets live under `$CLIMON_HOME` (default `~/.climon`). If
you have orphaned entries from killed processes, you can remove
`~/.climon/sessions/*` and `~/.climon/sock/*`. Use `climon kill <id>` to stop a
session and clear its metadata properly.
