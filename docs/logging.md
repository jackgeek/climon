# Logging

climon uses [pino](https://getpino.io) for structured logging across the client,
per-session daemon, dashboard server, and remote ingest/uplink processes, plus a
browser logger for the dashboard.

## Turning logging on and off

Logging is controlled by a single level. From most to least verbose:
`trace`, `debug`, `info`, `warn`, `error`, `fatal`, and `silent` (off).

The effective level is resolved with this precedence:

1. `CLIMON_LOG_LEVEL` environment variable (per-invocation override)
2. `logging.level` in `config.jsonc`
3. `silent` automatically when running `bun test`
4. Default: `trace`

### Disable logging

- Permanently: `climon config set logging.level silent`
- For one command: `CLIMON_LOG_LEVEL=silent climon ...`

### Re-enable / change verbosity

- `climon config set logging.level info`
- One-off deep debugging: `CLIMON_LOG_LEVEL=debug climon ...`

### Setting CLIMON_LOG_LEVEL persistently

`bun run log-level <level>` persists the `CLIMON_LOG_LEVEL` environment variable
for your user. It works on Windows (via `setx` / the `HKCU\Environment` registry
key) and on Unix/WSL (via a managed block in your shell rc file):

- `bun run log-level debug` — set the level
- `bun run log-level silent` — turn logging off
- `bun run log-level --unset` — remove the persistent override
- `bun run log-level --show` — print the current value

A process can't change its parent shell, so the new value applies to new
terminals; the command also prints how to apply it in the current session
(`$env:CLIMON_LOG_LEVEL='debug'` on PowerShell, `export CLIMON_LOG_LEVEL=debug`
on bash).


## Where logs go

NDJSON log files are written under `$CLIMON_HOME/logs/<role>/`:

| Role   | Path                                  |
|--------|---------------------------------------|
| server | `logs/server/<timestamp>-<pid>.log`   |
| client | `logs/client/<timestamp>-<pid>.log`   |
| daemon | `logs/daemon/<session-id>.log`        |
| ingest | `logs/ingest/<timestamp>-<pid>.log`   |
| uplink | `logs/uplink/<timestamp>-<pid>.log`   |

The daemon also keeps a raw crash file at `sessions/<session-id>.log` for
uncaught stack traces.

### Tailing logs with lnav

Run `bun run logs` to open [lnav](https://lnav.org/) on `$CLIMON_HOME/logs`,
which tails and searches every role's NDJSON files in one place. Extra arguments
are forwarded to lnav, e.g. `bun run logs -- -c ':filter-in error'`.

lnav has no native Windows build, so on Windows `bun run logs` automatically
falls back to running lnav inside WSL (the logs path is translated with
`wslpath`). Install lnav first — `brew install lnav`, `apt install lnav`, or
`dnf install lnav` (inside WSL on Windows).


On a terminal, the server and (when not attached) the client also pretty-print:
`info`/`warn` to stdout and `error`/`fatal` to stderr. The client suppresses
terminal output while it is attached to your session so it never corrupts your
shell; those logs still go to the file.

## Browser logs

The dashboard logs to the browser devtools console via `pino/browser`. Raise the
browser level by setting `localStorage["climon:logLevel"] = "debug"` in devtools
and reloading.

## Redaction

Secrets (auth tokens, tunnel credentials, the App Insights connection string)
are redacted to `[REDACTED]` in all log output.

## Application Insights (optional)

The dashboard server can forward logs to Azure Application Insights. Set a
connection string and it is enabled automatically (off by default):

- `climon config set logging.appInsights.connectionString "<connection-string>"`
- or the `APPLICATIONINSIGHTS_CONNECTION_STRING` environment variable

This sends log data over the network and is opt-in only.

## Logging during tests

`bun test` sets the level to `silent` automatically (via `tests/log-silence.ts`,
registered in `bunfig.toml`), so tests produce no output and create no log files.
Override with `CLIMON_LOG_LEVEL=debug bun test` when debugging a test.
