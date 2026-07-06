# climon Privacy Policy

_Last updated: 2026-07-03_

This Privacy Policy explains what data the climon software ("climon", "the
software", "we", "us") collects, why, and the choices you have. climon is an
open-source, cross-platform terminal session manager. It runs entirely on your
own machines: your sessions, terminal output, commands, and files never leave
your computer as part of normal operation.

The only data climon can send off your machine is **optional, opt-in usage
telemetry**, described below. This policy is written to apply worldwide,
including for people in the European Economic Area (EEA), the United Kingdom,
Switzerland, the United States (including California), Canada, Brazil, and other
jurisdictions.

## TL;DR

- Telemetry is **off by default**. Nothing is sent unless you explicitly enable
  it with `climon config telemetry.enabled true`.
- climon is **designed never to collect personal or personally identifiable
  information (PII)**. No usernames, hostnames, IP addresses, file paths,
  command lines, terminal output, or file contents are collected.
- When telemetry is enabled, data is keyed only by a **random, anonymous install
  identifier** that you can reset or delete at any time.
- You can disable telemetry at any time and it takes effect immediately for
  future runs.

## 1. Data climon does NOT collect

climon is architected so that the following never leave your machine, whether or
not telemetry is enabled:

- Session output, terminal scrollback, or screen contents.
- Command lines, arguments, environment variables, or their contents.
- File paths, working directories, file names, or file contents.
- Hostnames, usernames, user IDs, email addresses, IP addresses, or MAC
  addresses.
- Authentication tokens, tunnel credentials, connection strings, passwords, or
  any other secret. These are additionally redacted from all local logs.
- Any other information that identifies you, your organization, or your machines.

**Exception: optional attention notifications.** When `feature.smartNotifications`
is enabled (off by default), attention notifications include a fuzzy-extracted snippet
of terminal output (≤160 chars) as the notification body. This means that terminal
content leaves your machine in push notification payloads (for mobile PWA
notifications) and in remote-session metadata when a session on a remote devbox
flags attention (the snippet is synced to the dashboard host along with the session
status). The snippet never appears in telemetry; it is opt-in via the
`feature.smartNotifications` flag and can be turned off again by setting it to `disabled`.

There are **no advertising, profiling, tracking, or data-broker integrations**
of any kind, and climon does not sell or share data for such purposes.

## 2. Optional telemetry (opt-in)

### 2.1 What it is

The climon dashboard **server** (`climon-server`) can forward diagnostic and
usage telemetry to Microsoft Azure Application Insights. This is intended to
help maintainers understand which features are used and to diagnose errors in
aggregate. The climon **client** has no telemetry transport and never sends
telemetry.

### 2.2 It is off by default

Telemetry only runs when **all** of the following are true:

1. You have explicitly opted in by setting `telemetry.enabled` to `true` (via
   `climon config telemetry.enabled true` or during `climon setup`). The default
   is `false`.
2. The build you are running has a telemetry endpoint configured (official
   release binaries do; a build with no endpoint sends nothing even if you opt
   in).

If either condition is not met, no telemetry endpoint is contacted.

### 2.3 What is collected when enabled

When telemetry is enabled, climon forwards structured diagnostic log records.
Each record may include:

- A **random, anonymous install identifier** (`install.id`) — a UUID generated
  locally on first run and stored in your climon configuration. It contains no
  personal information and exists only so records from one installation can be
  distinguished from another in aggregate.
- The application role (e.g. `server`), the process ID, and the climon version.
- A **stable message identifier** (an 8-character hexadecimal code) instead of
  the human-readable log text, so variable, potentially sensitive rendered text
  does not leave your machine.
- Non-sensitive structured parameters. Any parameter classified as sensitive
  (hostnames, paths, URLs, configuration values, tokens, or PII) is replaced
  with a typed redaction marker such as `[REDACTED:path]` before transmission.
- Diagnostic parameters (error, reason, and status messages) are **sanitized**
  rather than sent verbatim: the diagnostic skeleton (error codes, system-call
  names, HTTP statuses) is preserved, while any embedded file path, hostname, IP
  address, URL, email, or long token is stripped and replaced with a typed
  marker such as `<path>` or `<host>`. This lets us diagnose errors in aggregate
  without receiving identifying values; the sanitizer errs on the side of
  removing too much.

Telemetry is keyed only by the anonymous install identifier. It is not linked to
your identity, and we do not attempt to re-identify you from it.

### 2.4 No free-form text is transmitted

Telemetry emission is allowlist-based: only a fixed set of non-identifying
fields (an anonymous install id, the application role, process id, climon
version, component, and a stable message id) plus explicitly-classified,
redacted-or-sanitized message parameters are ever transmitted. Rendered log
text, serialized errors, and any unrecognized field are dropped before anything
leaves your machine — including for internal or not-yet-catalogued log records,
which are reduced to a bare identifier.

## 3. Legal basis and your rights

Because climon's telemetry is opt-in and keyed only by a random identifier that
is not linked to your identity, it is designed to fall outside the scope of most
personal-data regimes. Where any applicable law nonetheless treats this data as
personal data:

- **Legal basis (GDPR/UK GDPR):** our legal basis is your **consent**, given by
  enabling telemetry. You may withdraw consent at any time (see Section 4)
  without affecting the lawfulness of processing before withdrawal.
- **Your rights:** depending on where you live, you may have rights to access,
  correct, delete, restrict, or object to processing of your personal data, to
  data portability, and to lodge a complaint with a supervisory authority (for
  EEA/UK residents) or your local regulator. Because telemetry is anonymous and
  not linked to your identity, we generally cannot identify your individual
  records; you can exercise the practical equivalent by disabling telemetry and
  resetting your install identifier (Section 4).
- **California (CCPA/CPRA) and similar US state laws:** climon does not sell or
  share personal information and does not use it for targeted advertising or
  profiling.
- **No sale, no automated decision-making, no profiling.**

## 4. Your choices and controls

- **Disable telemetry:** `climon config telemetry.enabled false`. This takes
  effect for future runs immediately.
- **Never enable it:** the default is disabled, so no action is needed to opt
  out.
- **Reset your anonymous identifier:** you can delete or replace the
  `install.id` value in your climon configuration
  (`$CLIMON_HOME/config.jsonc`, default `~/.climon`). A new random identifier is
  generated on next run only if telemetry is enabled.
- **Local logs:** climon writes logs to `$CLIMON_HOME` on your machine. These
  never leave your machine unless telemetry is enabled, and secrets are redacted
  within them. You may delete them at any time.

## 5. Data recipients, storage, and retention

- **Processor:** when telemetry is enabled, records are transmitted to Microsoft
  Azure Application Insights, which processes and stores them on our behalf.
  Microsoft's handling of this data is governed by the
  [Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement)
  and the applicable Microsoft data protection terms.
- **International transfers:** telemetry may be processed in data centers outside
  your country, including in regions operated by Microsoft. Where required,
  transfers rely on appropriate safeguards (such as Standard Contractual
  Clauses).
- **Retention:** telemetry is retained only as long as needed for aggregate
  diagnostics and product improvement, subject to the Application Insights
  retention configuration, after which it is deleted or aggregated.

## 6. Children

climon is a developer tool not directed at children and does not knowingly
collect any data from children.

## 7. Security

The telemetry endpoint credential is never stored in climon configuration or
committed to source; it is embedded into official release binaries at build
time. Secrets are redacted from all logs. See
[docs/security.md](security.md) for climon's broader security model.

## 8. Changes to this policy

We may update this Privacy Policy as climon evolves. Material changes will be
noted in the project changelog and the "Last updated" date above. Because
telemetry is opt-in, any expansion of collected data will remain subject to your
explicit opt-in.

## 9. Contact

climon is an open-source project maintained on GitHub. For privacy questions or
requests, open an issue at
<https://github.com/jackgeek/climon/issues>.
