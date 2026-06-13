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
