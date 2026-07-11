# Dev-tunnel resilience and failure handling

**Date:** 2026-07-11
**Branch:** `design/devtunnel-resilience`
**Status:** Design approved; pending implementation plan

## Problem

Climon uses Microsoft Dev Tunnels for two related products:

- **Tunnel Link:** the Bun dashboard server exposes the local dashboard through an
  authenticated dev tunnel.
- **Remote sessions:** the Bun server creates and hosts the home ingest tunnel,
  while the Rust client discovers tunnels and runs the remote `connect`, `host`,
  and port-inspection operations.

Dev-tunnel policy is not centralized today. The Bun dashboard tunnel manager,
server-side remote helpers, Rust launcher, Rust discovery, Rust uplink, and Rust
ingest code invoke or interpret `devtunnel` independently. The resulting failure
behavior is inconsistent:

- an unauthenticated user receives instructions but no coherent retry flow;
- tunnel quota exhaustion can surface as raw rate-limit output rather than an
  explanation that too many tunnels already exist;
- some discovery failures become an empty result and look like "no hosts";
- some process-spawn and host failures become silent no-op behavior;
- startup failures are logged but are not visible in dashboard or remote status;
- retry behavior is distributed and does not distinguish transient failures from
  user-actionable failures;
- the Tunnel Link menu is hidden when the CLI is missing, so users cannot discover
  how to enable it.

## Goals

1. Give every dev-tunnel operation a consistent, typed failure model.
2. Centralize command execution, process supervision, error classification,
   redaction, and retry policy within each shipping runtime.
3. Keep Bun and Rust behavior aligned through a shared contract and fixtures.
4. Surface friendly, actionable failures in the dashboard and `climon remotes`.
5. Preserve technical details for diagnosis without making raw CLI output the
   primary user experience.
6. Make background startup, discovery, hosting, and reconnect behavior resilient
   without creating retry storms.
7. Keep Tunnel Link discoverable when Dev Tunnels is not installed.

## Non-goals

- Replacing Microsoft Dev Tunnels with another tunnel provider.
- Automatically installing the `devtunnel` CLI.
- Automatically deleting any user or Climon-managed tunnel.
- Combining the independently shipped Rust client and Bun server into one process.
- Adding a new broker daemon or IPC protocol solely for tunnel operations.
- Changing the authenticated, non-anonymous Tunnel Link security model.

## Architectural decision

Use **runtime-local gateways with one shared behavioral contract**.

Climon ships two independent binaries, so one in-process module cannot govern every
operation without introducing an undesirable runtime dependency. Instead:

### Bun dev-tunnel gateway

One Bun module owns every server-side `devtunnel` command and hosted process used
by:

- Dashboard Tunnel Link;
- ingest-tunnel creation and port management;
- server-side ingest tunnel hosting;
- availability and authentication probes.

Dashboard and remote managers retain product-specific lifecycle responsibilities,
such as persisted tunnel identity, dashboard URL verification, ingest desired
state, and configuration updates. They do not spawn `devtunnel`, construct its
environment, parse its failures, or implement retry policy directly.

### Rust dev-tunnel gateway

One Rust module owns every client-side `devtunnel` command and process used by:

- CLI availability and authentication probes;
- labeled ingest-tunnel discovery;
- tunnel port inspection;
- uplink `connect`;
- ingest `host`;
- process output capture and supervision.

The launcher, discovery, uplink, and ingest modules consume typed gateway results.
They do not construct `devtunnel` commands or silently reinterpret failures.

### Shared contract

Bun and Rust implement the same versioned contract:

- operation names;
- health and lifecycle states;
- stable error codes;
- retry classes;
- retry metadata;
- user-facing summaries;
- remediation actions;
- sanitized technical details;
- status serialization.

Checked-in fixtures contain representative structured responses and CLI output.
Both runtime test suites must classify each fixture identically. The fixtures are
the parity boundary; the runtimes do not need to share executable code.

## Gateway operations

The contract covers at least these operations:

- `detect`
- `show-user`
- `list-tunnels`
- `show-tunnel`
- `create-tunnel`
- `delete-tunnel`
- `list-ports`
- `create-port`
- `delete-port`
- `host-tunnel`
- `connect-tunnel`

Command runners return captured status, stdout, stderr, command metadata, start/end
times, and spawn failures. Long-running process handles additionally expose
lifecycle state and an output/event stream suitable for URL detection, auth
failure detection, and exit classification.

The gateways own shared environment behavior such as the Linux ICU library path,
disabled-development guards, stdin detachment, stream capture, and Windows console
suppression.

## Failure model

Every unsuccessful operation returns a typed dev-tunnel failure rather than a raw
exception, empty collection, or no-op process.

Initial stable error codes:

| Code | Meaning |
|---|---|
| `cli_missing` | The CLI could not be found or executed. |
| `not_authenticated` | No usable Dev Tunnels identity is logged in. |
| `tunnel_quota_exhausted` | The account has reached its allowed tunnel count. |
| `rate_limited` | A service request or traffic rate limit was reached, distinct from tunnel-count quota. |
| `permission_denied` | The identity lacks permission for the requested tunnel operation. |
| `tunnel_not_found` | The referenced persisted/configured tunnel no longer exists. |
| `port_conflict` | The requested port mapping already exists or conflicts. |
| `network_unavailable` | DNS, connection, or local network access failed. |
| `service_unavailable` | The Dev Tunnels service is temporarily unavailable. |
| `process_exited` | A long-running host/connect process exited unexpectedly. |
| `invalid_output` | Successful-looking output could not be parsed safely. |
| `unknown` | The failure does not match a known classification. |

Each failure includes:

- `code`;
- `operation`;
- friendly `summary`;
- actionable `remediation`;
- sanitized `technicalDetail`;
- command exit status when available;
- `occurredAt`;
- `retryable`;
- optional `retryAfter`;
- retry class: `transient`, `actionable`, `permanent`, or `unknown`.

### Classification

Classification uses, in order:

1. structured CLI/service fields when available;
2. command exit/spawn state;
3. version-aware, tested stdout/stderr patterns;
4. `unknown`.

Classification must inspect stdout and stderr because Dev Tunnels may emit
diagnostic or service output to either stream. Raw output is sanitized using the
same logging/privacy rules before it reaches status files, API responses, UI, or
logs.

Tunnel-count quota exhaustion must remain distinct from general rate limiting.
The user message explains that the account already has too many tunnels and
provides inspection and cleanup guidance. Climon never deletes a tunnel
automatically.

## Retry and recovery policy

### Transient failures

Network failures, service unavailability, ordinary throttling, and unexpected
long-running process exits retry with exponential backoff, jitter, and a maximum
delay. A successful operation resets the backoff.

The current retry state is observable: next retry time, attempt count, and last
failure are included in health/status data.

### Actionable failures

Missing CLI, missing authentication, tunnel-count quota exhaustion, permission
denial, and other user-actionable failures pause background retries. They resume
when:

- the user invokes an explicit Retry action;
- a relevant probe observes changed state, such as the CLI becoming available or
  authentication succeeding;
- configuration changes replace the failing target.

Authentication is never launched automatically. The UI and CLI show the exact
command:

```text
devtunnel user login
```

After the user completes it, they use an explicit Retry button or command.

### Product-specific recovery

Existing intended self-healing remains:

- a missing persisted dashboard tunnel may be forgotten and recreated;
- an already-existing desired port remains an idempotent success;
- stale dashboard port mappings may be pruned;
- an unreachable newly hosted dashboard tunnel may be recreated once;
- a changed ingest port may be reconciled.

These behaviors consume typed error codes instead of matching raw strings locally.
Destructive recovery never expands to deleting unrelated tunnels.

## Health and status model

Each gateway exposes a health snapshot with:

- CLI availability and version;
- authentication state and safe identity metadata where already appropriate;
- current operation/process state;
- active tunnel IDs and ports relevant to that product;
- last successful operation time;
- last failure;
- retry state;
- last probe time.

The Bun dashboard APIs return structured JSON errors and health data instead of
plain error text. HTTP status codes are mapped from stable error codes, but clients
must use the JSON code rather than parsing status text.

The Rust remote path writes the same normalized failure and retry data into the
existing ingest/uplink status beacons. `climon remotes` renders the friendly
summary, stable code, last failure time, retry state, remediation, and optional
technical detail.

An authenticated discovery failure must not be represented as an ordinary empty
tunnel list. "No live Climon hosts exist" and "Climon could not query Dev Tunnels"
are distinct states.

## Dashboard user experience

### Tunnel Link visibility

The Tunnel Link menu item is always visible. It is no longer conditional on a
successful CLI probe.

Clicking it opens one state-driven dialog:

- **CLI missing:** explain that Microsoft Dev Tunnels is required, link to the Dev
  Tunnels installation instructions in climon's GitHub `README.md`, show optional
  expandable technical details, and provide Retry.
- **Not authenticated:** show `devtunnel user login`, expandable technical detail,
  and Retry.
- **Tunnel quota exhausted:** explain that too many tunnels already exist, show
  `devtunnel list` and explicit cleanup guidance, and provide Retry. Do not offer
  automatic deletion.
- **Transient failure:** show the friendly error, automatic retry state, Retry now,
  and expandable technical detail.
- **Starting/retrying:** show progress and next-retry information.
- **Running:** retain the link copy/open controls and tunnel identity.

The GitHub README installation target is exported from one documentation-link
module or constant rather than embedded in the component. This makes the planned
future migration to `climon.org/docs` a one-place change.

### Remotes surfaces

The Remotes dialog shows the ingest tunnel's normalized health instead of only
"tunnel exists" or "CLI unavailable." It provides the same authentication,
installation, quota, service-failure, technical-detail, and Retry treatment.

`climon remotes` uses an equivalent terminal representation. Human output is
friendly by default, with technical details available through the command's
detailed/JSON surface rather than replacing the friendly message.

### Background startup

Tunnel failures never prevent the local dashboard or ingest listener from starting
when those can still operate. Previously enabled Tunnel Link and remotes failures
remain non-fatal, but their paused/retrying state is persisted and shown in the
dashboard instead of only being written to stderr or debug logs.

## Data flow examples

### Missing authentication while starting Tunnel Link

1. The user clicks the always-visible Tunnel Link item.
2. The dashboard calls the structured ensure endpoint.
3. The Bun gateway runs availability and identity probes.
4. Identity output classifies as `not_authenticated`.
5. The API returns the typed failure.
6. The dialog shows `devtunnel user login`, technical details, and Retry.
7. The user runs the command manually and clicks Retry.
8. Probes succeed; tunnel creation/port hosting continues.

### Tunnel-count quota exhaustion

1. A create operation receives the service/CLI quota response.
2. The gateway classifies it as `tunnel_quota_exhausted`, not generic
   `rate_limited`.
3. Background retry pauses because creating repeatedly cannot resolve the account
   state.
4. The UI or CLI explains that the account has too many tunnels and suggests
   `devtunnel list` plus manual deletion of an unused tunnel.
5. The user cleans up outside Climon and explicitly retries.

### Discovery service outage

1. Rust discovery invokes `list-tunnels` through the gateway.
2. The service failure classifies as transient.
3. The existing known targets can continue their independent reconnect behavior;
   discovery does not falsely report a successful empty list.
4. Status records the failure and scheduled retry.
5. Backoff retries until the service returns; success clears the failure.

## Implementation stages

1. **Contract and classifiers**
   - Define shared error/status fixtures and schemas.
   - Implement Bun and Rust classification parity tests.
   - Implement gateway runners and common process primitives.
2. **Dashboard Tunnel Link**
   - Route all dashboard operations through the Bun gateway.
   - Return structured API failures.
   - Make the menu always visible.
   - Add the state-driven dialog, README install link, details, and Retry.
3. **Server-side ingest**
   - Route ingest creation, port reconciliation, and hosting through the Bun
     gateway.
   - Expose startup and runtime health in remote status.
4. **Rust remotes**
   - Route launcher probes, discovery, port inspection, connect, and host through
     the Rust gateway.
   - Replace empty/silent failure behavior with typed status and retry policy.
   - Render the state in `climon remotes`.
5. **Cleanup**
   - Remove remaining direct `devtunnel` command construction and local output
     pattern matching.
   - Confirm all call sites use the gateways and shared contract.

The stages may be delivered as separate commits or pull requests, but no stage may
introduce a second competing error contract.

## Testing

### Automated

- Shared fixtures classify to the same code, retry class, remediation category,
  and safe detail in Bun and Rust.
- Availability distinguishes missing CLI from other execution failures.
- Authentication recognizes documented JSON and text output.
- Tunnel quota exhaustion remains distinct from generic rate limiting.
- Permission, missing-tunnel, port-conflict, network, service, process-exit,
  invalid-output, and unknown paths are covered.
- Technical output sanitization removes sensitive values before serialization.
- Fake-clock tests cover exponential backoff, jitter bounds, cap, reset, pause, and
  explicit resume.
- Dashboard API tests cover structured success/failure responses and status codes.
- Tunnel Link UI tests cover always-visible menu behavior, every dialog state,
  README install link, details disclosure, and Retry.
- Existing dashboard tunnel reuse, stale-port pruning, URL verification, and
  one-time recreation behavior remain covered.
- Server remote tests cover ingest startup failures and port reconciliation.
- Rust tests cover discovery failure versus empty success, connect/host exits,
  beacon serialization, and `climon remotes` rendering.
- Process tests retain Windows no-console behavior and Linux ICU environment
  handling.

### Manual

Add or update manual checks for:

- `devtunnel` absent;
- CLI installed after the dialog is already open, followed by Retry;
- logged-out identity and manual login followed by Retry;
- tunnel-count quota exhaustion and manual cleanup;
- generic rate limiting;
- temporary service/network outage and backoff recovery;
- missing persisted tunnel self-heal;
- host/connect process exit and recovery;
- successful Tunnel Link and remote ingest/uplink operation;
- dashboard and `climon remotes` status consistency.

Update the manual-test index and `docs/features.md` with factual implemented
behavior as each implementation stage lands.

## Documentation

Implementation updates:

- `README.md` for user-facing setup and Tunnel Link behavior;
- `docs/troubleshooting.md` for each actionable failure and cleanup guidance;
- `docs/architecture.md` for the runtime-local gateway boundary and status flow;
- `docs/security.md` only if exposed identity/detail fields or network behavior
  change;
- `docs/manual-tests/` and its index;
- `docs/features.md`.

The missing-CLI UI links to the applicable Dev Tunnels installation section in the
GitHub README until the future `climon.org/docs` site exists.

## Risks and mitigations

- **CLI output changes:** prefer structured data and keep versioned fallback
  fixtures; unknown output remains visible as safe technical detail.
- **Bun/Rust drift:** shared fixtures are required in both test suites and stable
  error codes are treated as an API contract.
- **Retry storms:** actionable failures pause; transient retries use capped,
  jittered backoff and operation coalescing.
- **Sensitive diagnostic leakage:** sanitize before data crosses the gateway
  boundary, not only at the final log sink.
- **Status complexity:** use one normalized health/failure structure and derive
  product-specific views rather than creating separate dashboard, API, beacon, and
  CLI error models.
- **Behavior regression during migration:** migrate one product surface at a time
  while preserving existing reuse and self-heal tests, then remove direct call
  sites only after parity is established.
