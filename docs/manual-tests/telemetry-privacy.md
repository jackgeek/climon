# Telemetry privacy — no PII / no user command in telemetry egress

These checks prove that opt-in Application Insights telemetry from the Bun
`climon-server` never transmits personally identifiable information, the
user-supplied command a session runs, or rendered free-form log text. They
exercise the egress transform end-to-end: the compacting/allowlisting transform
(`src/logging/appinsights-transform.ts`), the diagnostic sanitizer
(`src/logging/sanitize.ts`), and the `subcommand`-only CLI invocation record.

Because a real Application Insights endpoint is not needed to observe egress
shape, these cases capture the compacted NDJSON the transform produces (its
output is what is piped to Azure) rather than asserting on Azure ingestion.

Preconditions common to all cases:

- A checkout with `bun install` completed.
- Familiarity with the message catalog `src/i18n/messages.en.json`.
- Telemetry is opt-in and off by default; these checks concern *what shape*
  leaves the process **when** a user has opted in (`telemetry.enabled true`).

---

## MT-TELEMETRY-PII-01 — Diagnostic errors are sanitized, not leaked

- **ID:** MT-TELEMETRY-PII-01
- **Feature:** Telemetry diagnostic sanitization
- **Preconditions:** Common preconditions.
- **Config-matrix cell:** Server = Bun `climon-server`; telemetry = enabled.
- **Platforms:** macOS, Linux, Windows host.

**Steps:**
1. Run the diagnostic sanitizer over representative error text:
   ```sh
   bun -e 'import("./src/logging/sanitize.js").then(m => console.log(m.sanitizeDiagnostic("ENOENT open /Users/alice/.climon/config.jsonc at host.corp.example:22 https://abc.devtunnels.example/x for bob@example.com")))'
   ```

**Expected result:** The output preserves the diagnostic skeleton (e.g.
`ENOENT`) but contains no path, hostname, IP, URL, or email — those are replaced
with `<path>`, `<host>`, `<ip>`, `<url>`, `<email>` markers.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |

---

## MT-TELEMETRY-PII-02 — Uncatalogued records never carry rendered text

- **ID:** MT-TELEMETRY-PII-02
- **Feature:** Telemetry field allowlisting
- **Preconditions:** Common preconditions.
- **Config-matrix cell:** Server = Bun `climon-server`; telemetry = enabled.
- **Platforms:** macOS, Linux, Windows host.

**Steps:**
1. Feed the compacting transform an uncatalogued record with sensitive text and
   a stray field, and inspect what it emits:
   ```sh
   bun -e 'import("./src/logging/appinsights-transform.js").then(m => { const t = m.createCompactingTransform({}); let out=""; t.on("data",c=>out+=c); t.on("end",()=>console.log(out)); t.end(JSON.stringify({role:"server",pid:1,installId:"iid",msg:"boom /Users/alice/secret host.corp.example",secretField:"tok_abc"})+"\n"); })'
   ```

**Expected result:** The emitted line is a JSON record with `msgId`/`msg` set to
`00000000`, only the allowlisted base fields present, and it contains none of
`/Users/alice`, `host.corp.example`, `secretField`, or `tok_abc`.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |

---

## MT-TELEMETRY-PII-03 — Only the climon subcommand is recorded, never the user command

- **ID:** MT-TELEMETRY-PII-03
- **Feature:** CLI invocation telemetry (`subcommand` only)
- **Preconditions:** Common preconditions; a debug-level log destination.
- **Config-matrix cell:** Client = Rust `climon`; log level = debug.
- **Platforms:** macOS, Linux, Windows host.

**Steps:**
1. With `CLIMON_LOG_LEVEL=debug` (and a temporary `CLIMON_HOME`), run a command
   that spawns a user program, e.g. `climon run -- echo my-secret-arg` (or the
   equivalent on your platform).
2. Inspect the CLI debug log under `$CLIMON_HOME/logs/`.

**Expected result:** The `cli.command_invocation` record contains
`"subcommand":"run"` and does **not** contain `echo`, `my-secret-arg`, or any
other part of the user-supplied command line.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |

---

## MT-TELEMETRY-PII-04 — Local logs keep full fidelity

- **ID:** MT-TELEMETRY-PII-04
- **Feature:** Egress-only redaction
- **Preconditions:** Common preconditions.
- **Config-matrix cell:** Server = Bun `climon-server`; telemetry = enabled.
- **Platforms:** macOS, Linux, Windows host.

**Steps:**
1. Trigger a server-side error that produces a diagnostic log record referencing
   a real path or host (e.g. start the server with an already-bound port).
2. Compare the on-disk log file under `$CLIMON_HOME/logs/` with the compacted
   telemetry shape from MT-TELEMETRY-PII-01/02.

**Expected result:** The local file log still contains the full, unredacted
rendered text (for debugging), while only the telemetry egress path is
sanitized/allowlisted. Redaction/sanitization must not degrade local logs.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |
