# Logging

climon emits structured NDJSON logs across the client, per-session daemon,
dashboard server, and remote ingest/uplink processes, plus a browser logger for
the dashboard. The Rust processes (client, daemons, ingest/uplink) use an
in-house [pino](https://getpino.io)-compatible logger, while the Bun dashboard
server and browser dashboard use pino itself — so the log format (levels, field
names, NDJSON layout) is consistent across all of them.

## Turning logging on and off

Logging is controlled by a single level. From most to least verbose:
`trace`, `debug`, `info`, `warn`, `error`, `fatal`, and `silent` (off).

The effective level is resolved with this precedence:

1. `CLIMON_LOG_LEVEL` environment variable (per-invocation override)
2. `logging.level` in `config.jsonc`
3. `silent` automatically when running `bun test`
4. Default: `trace`

### Disable logging

- Permanently: `climon config logging.level silent`
- For one command: `CLIMON_LOG_LEVEL=silent climon ...`

### Re-enable / change verbosity

- `climon config logging.level info`
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

The dashboard server can forward logs to Azure Application Insights. Forwarding
is **off by default** and only happens when you opt in with:

```sh
climon config telemetry.enabled true
```

The connection string is a secret and is **never stored in climon config**. Supply
it in one of two ways:

- the `APPLICATIONINSIGHTS_CONNECTION_STRING` environment variable on the machine
  that runs the dashboard server, or
- the build-time `EMBEDDED_TELEMETRY_CONNECTION` constant baked into release
  binaries by the release pipeline (`src/telemetry/connection.ts`).

When `telemetry.enabled` is `true` and a connection string is available from one
of those sources, the server forwards logs; otherwise it stays local-only. This
sends log data over the network and is opt-in only. See the
[Privacy Policy](privacy.md) for what is and is not collected and how it is
handled.

Every record forwarded to Application Insights carries an anonymous
`installId` — a random UUID stored in `$CLIMON_HOME/install.json`, generated on
first server start. It contains no personal information and exists only so logs
from one installation can be distinguished from another.

Turn forwarding off at any time with `climon config telemetry.enabled false`.

### Compact emission

Records are rewritten before they leave the process so Application Insights
never receives rendered message text:

- Catalogued messages (logged via the `logMsg` helper) are sent as their 8-hex
  message id in the trace `message` field instead of the full string. The hex id
  maps back to the source template in `src/i18n/messages.en.json`, which a log
  viewer (Azure Workbook / KQL `externaldata` join, Grafana, or Seq) can stitch
  back in realtime — the same catalog also drives i18n.
- Every catalog entry carries a required `hint`: a short translator-facing note
  describing the message's context, tone, and what each `{placeholder}` means. It
  is enforced by `bun run messages:check` and published into the lookup so the
  viewer can show it alongside the template.
- Interpolation arguments are attached as flat top-level properties, but any
  parameter the catalog entry marks `redact: true` (hostnames, paths, URLs,
  config values, tokens, PII) is replaced with `[REDACTED:<category>]` before
  sending. Non-redacted params stay as queryable properties.
- Diagnostic params (`category: "diagnostic"`, e.g. error/reason/message text)
  are the exception: instead of being blanked, they are passed through the
  diagnostic sanitizer (`src/logging/sanitize.ts`), which keeps the diagnostic
  skeleton (error codes, syscalls, HTTP statuses) but strips identifier-shaped
  tokens — paths, hostnames, IPs, URLs, emails, and long hex/opaque tokens are
  replaced with `<path>`, `<host>`, `<ip>`, `<url>`, `<email>`, `<id>` markers,
  and the value is truncated. This keeps error telemetry useful without leaking
  identifiers; when in doubt the sanitizer over-redacts.
- Emission is **allowlist-based**: only a fixed set of non-identifying base
  fields (`level`, `time`, `role`, `pid`, `version`, `installId`, `component`,
  `msgId`, `msgKey`) plus the record's own catalog parameters (redacted or
  sanitized as above) are forwarded. The rendered `msg`, serialized errors, and
  any stray properties are dropped.
- Records with no catalog entry — uncatalogued records, or a not-yet-migrated
  `logMsg` key that resolves to the sentinel id — forward only the allowlisted
  base fields under the sentinel id `00000000`; their rendered text is never
  transmitted. Lines that cannot be parsed as JSON are replaced with a bare
  sentinel record rather than forwarded raw.

Local log streams (console, file) always keep the full rendered text; only the
Application Insights stream is compacted and redacted.

### Viewing compacted logs

Because Application Insights stores the 8-hex id rather than the message text,
re-attach the template at view time by joining against the published catalog —
no custom viewer is needed. Publish the lookup whenever the catalog changes:

```sh
bun run messages:publish   # writes dist/messages.en.csv and dist/messages.en.lookup.json
```

Host `messages.en.csv` somewhere the viewer can read (e.g. an Azure blob with a
read SAS URL), then use **Azure Monitor Workbooks** (or Grafana with the Azure
Monitor data source) with a KQL query that joins on the id:

```kusto
let Catalog = externaldata(id:string, key:string, template:string, hint:string, params:string, redacted:string)
    [@"https://<your-blob>/messages.en.csv"] with(format='csv', ignoreFirstRecord=true);
traces
| extend msgId = tostring(customDimensions.msgId)
| join kind=leftouter Catalog on $left.msgId == $right.id
| project TimeGenerated, severityLevel, template, customDimensions
| order by TimeGenerated asc
```

The workbook auto-refresh interval gives realtime tailing. Joining id → template
is native; full `{param}` re-interpolation is not a KQL one-liner, so display the
template alongside the `customDimensions` properties grid (redacted params already
show as `[REDACTED:<category>]`). The `params`/`redacted` columns tell a query
which properties map into a template and which were scrubbed. Queries run under
the viewer's existing Azure RBAC — climon stores no read credentials.

## Logging during tests

`bun test` sets the level to `silent` automatically (via `tests/log-silence.ts`,
registered in `bunfig.toml`), so tests produce no output and create no log files.
Override with `CLIMON_LOG_LEVEL=debug bun test` when debugging a test.
