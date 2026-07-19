# Cross-platform client/server CI harness design

## Summary

Add a deterministic end-to-end harness that builds and tests the climon Rust
client and Bun dashboard server together on GitHub-hosted macOS, Linux, and
Windows runners.

The harness uses TypeScript on Node.js, Playwright Test for browser automation,
and `node-pty` for attached terminal automation. It runs the same scenarios on
all three operating systems through small platform adapters. Manual-test
Markdown remains the human-readable source of truth, with explicit structured
metadata selecting reviewed scenario implementations.

The first version is a focused smoke gate. It proves that a source-built client
can run both headless and attached sessions, that the source-built server can
discover and display those sessions, that the dashboard terminal can exchange
live input and output, and that completed state is persisted and displayed.

## Goals

- Run the same end-to-end smoke suite on GitHub-hosted macOS, Ubuntu, and
  Windows runners.
- Build the Rust client and Bun server from the checked-out commit.
- Exercise the real client, session daemon, metadata store, server, dashboard,
  browser terminal, and PTY path together.
- Cover both a headless session and an attached client running inside a
  programmatic PTY.
- Use cases under `docs/manual-tests/` as the discoverable test catalogue.
- Preserve actionable evidence for every failed CI run.
- Keep platform differences behind narrow adapters rather than duplicating the
  harness.

## Non-goals

The first version does not automate:

- remote tunnels or remote ingest/uplink flows;
- Windows-to-WSL bridging;
- mobile browsers, installed PWAs, push notifications, or service-worker
  lifecycle;
- installers, update flows, release archives, or cross-compiled artifacts;
- visible OS terminal-window spawning;
- subjective visual-quality checks;
- every existing manual test.

These can be added as explicit scenarios later without changing the plan format
or allowing Markdown to execute arbitrary commands.

## Architecture

The harness lives in a focused top-level `harness/` directory. It is a
TypeScript project executed by Node.js. Playwright Test supplies test execution,
timeouts, traces, screenshots, and browser lifecycle. `node-pty` supplies a
real cross-platform pseudo-terminal: Unix PTYs on macOS/Linux and ConPTY on
Windows.

One entrypoint runs on every operating system. Platform adapters provide only
the differences the shared orchestration cannot avoid:

- executable suffixes and path handling;
- deterministic command and argument construction;
- PTY defaults;
- process-tree termination;
- platform labels and supported expectations.

The harness must not use shell interpolation for commands under test. Processes
are launched with executable paths and argument arrays so quoting differences
cannot alter a scenario.

Each run creates an isolated temporary `CLIMON_HOME`. The build fixture produces
the host `climon` client and dashboard server artifacts from the checked-out
commit. The environment supervisor starts the server on loopback port `0`,
reads the selected port from `server.json`, and waits for `/health` before any
scenario begins.

## Components

### Plan catalogue

The plan catalogue scans `docs/manual-tests/*.md` for fenced `yaml harness`
blocks associated with test-case headings. It validates required fields and
selects cases for the requested suite and current platform.

Markdown chooses only a stable scenario implementation key and bounded
parameters. It cannot supply commands, scripts, selectors, or arbitrary code.
Unknown scenario keys and malformed metadata fail catalogue validation.

Cases marked `manual`, or cases that do not list the current platform, are
reported as explicit skips. A case marked `automated` for the current platform
must execute; inability to resolve or start it is a failure.

### Build fixture

The build fixture:

1. builds the host Rust `climon` client from `rust/`;
2. builds the dashboard web assets and Bun server artifact from the checkout;
3. resolves the exact paths used by all scenarios;
4. records source revision and tool versions in the result bundle.

Build outputs are shared across scenarios within one OS job. A build failure
prevents scenario execution and is reported separately from a test failure.

### Deterministic session fixture

A small cross-platform fixture program removes shell prompts, quoting, locale,
and timing from terminal assertions. It:

- prints a unique `READY` marker after startup;
- reads line-oriented input;
- responds to `PING <token>` with `ECHO <token>`;
- exits only after `EXIT <code>`;
- returns the requested exit code.

Both initial scenarios run this same fixture through the real climon client.

### Environment supervisor

The supervisor owns:

- the temporary `CLIMON_HOME`;
- server and client process handles;
- server readiness detection;
- scenario deadlines;
- log capture;
- cleanup of owned process trees.

It records child process IDs when processes are created and terminates only
those owned trees. It never kills processes by a broad executable-name match.
Cleanup runs after success or failure. Failure to clean up an owned process is
reported as a cleanup failure.

### PTY driver

The PTY driver starts the built client through `node-pty`, waits for exact
fixture markers, sends sentinel input, captures output, and waits for a clean
exit. It exposes shared operations while the OS adapter supplies platform PTY
settings and termination behavior.

### Dashboard driver

The dashboard driver uses Playwright with stable accessible selectors. It can:

- wait for a session to appear;
- open the session terminal;
- wait for replay or live terminal text;
- send terminal input;
- observe session status transitions;
- collect browser console and failed-network-request evidence.

The harness should prefer user-visible roles, labels, and test IDs over CSS
structure. Any test ID added solely for automation must identify a semantic
control or state, not layout.

### Scenario registry

The registry maps reviewed scenario keys to TypeScript implementations. It is
the only executable bridge between Markdown plans and harness behavior.

The initial keys are:

- `client-server.headless-dashboard`
- `client-server.attached-pty`

### Artifact reporter

The reporter writes per-case structured JSON and a concise Markdown summary. It
also gathers server, daemon, client, fixture, browser, and cleanup evidence into
one OS-specific artifact directory.

## Manual-test metadata

Create `docs/manual-tests/cross-platform-ci-harness.md` and link it from
`docs/manual-tests/README.md`. Each automated case includes a fenced metadata
block directly beneath its standard manual-test fields:

```yaml harness
status: automated
suite: smoke
scenario: client-server.headless-dashboard
platforms: [macos, linux, windows]
timeoutSeconds: 90
```

The supported fields in the first version are:

- `status`: `automated` or `manual`;
- `suite`: the named harness suite;
- `scenario`: a stable registry key;
- `platforms`: any subset of `macos`, `linux`, and `windows`;
- `timeoutSeconds`: an integer from 1 through 600.

The parser associates the block with the nearest preceding test heading and
uses the standard `ID` field as the case identifier. Duplicate IDs, duplicate
harness blocks, unsupported fields, invalid platforms, and unbounded timeouts
are catalogue errors.

## Initial smoke cases

### CIH-01: Headless client/server/dashboard lifecycle

1. Start the deterministic fixture through the built client in headless mode.
2. Capture the new session ID from the client.
3. Wait for the session to appear as running in the dashboard.
4. Open the session terminal in Chromium.
5. Observe the fixture's `READY` marker through replay or live output.
6. Send a unique `PING` token through the browser terminal.
7. Observe the matching `ECHO` response.
8. Send `EXIT 0`.
9. Verify the dashboard reports the session completed.
10. Verify persisted metadata records successful completion and exit code zero.

This proves the source-built client, detached daemon, PTY, metadata, source-built
server, WebSocket bridge, xterm dashboard, browser input, and finalization path
work together.

### CIH-02: Attached PTY lifecycle

1. Start the deterministic fixture through the built client inside `node-pty`.
2. Observe the `READY` marker in the attached terminal.
3. Wait for the running session to appear in the dashboard.
4. Open the dashboard terminal and verify the fixture output is observable.
5. Send a unique `PING` token through the attached PTY.
6. Observe the matching `ECHO` response in the attached terminal.
7. Send `EXIT 0` through the attached PTY.
8. Verify the client and PTY exit cleanly.
9. Verify the dashboard reports the session completed.
10. Verify persisted metadata records successful completion and exit code zero.

This proves the attached local-client path while still validating server and
dashboard interoperability. It does not require the browser to take control
from the attached terminal.

## CI workflow

Add a GitHub Actions workflow with:

- a matrix over `ubuntu-latest`, `macos-latest`, and `windows-latest`;
- `fail-fast: false`;
- pull-request path filters covering harness code, manual-test metadata, Rust
  client/session code, Bun server code, and dashboard code;
- `workflow_dispatch` for explicit full runs;
- pinned Rust, Bun, and Node setup;
- harness dependency installation and Chromium installation;
- one harness worker per OS;
- no automatic test retries.

Each OS job uploads its artifact directory unconditionally. A final aggregation
job downloads all OS artifacts, merges the structured results, writes a
cross-platform JSON and Markdown summary, and fails if:

- any required case failed;
- an automated case for that platform did not run;
- catalogue validation failed;
- build or environment setup failed;
- cleanup failed.

CI does not modify or commit `docs/manual-tests/results/`. Generated evidence
can be used to populate those deliberate release records later.

## Failure handling

Failures are classified as:

- catalogue validation;
- build;
- server startup or health;
- client startup;
- PTY interaction;
- browser interaction;
- assertion;
- timeout;
- cleanup.

Every wait is bounded and reports the expected condition, elapsed time, and
relevant recent output. The harness must not silently convert startup or
interaction errors into skips.

On failure, the OS artifact contains:

- structured case results;
- source revision and tool versions;
- server, daemon, client, and fixture logs;
- Playwright trace and failure screenshot;
- browser console messages and failed network requests;
- a post-cleanup snapshot of regular files from the isolated `CLIMON_HOME`
  (excluding sockets, pipes, and other non-serializable filesystem entries);
- cleanup diagnostics;
- a concise Markdown summary.

The deterministic fixture and isolated home must not contain credentials or
user commands. Before upload, the reporter still redacts known secret-shaped
environment values and excludes unrelated process environment data.

## Documentation

Implementation updates:

- `docs/manual-tests/README.md` with the new case file;
- `docs/manual-tests/cross-platform-ci-harness.md` with CIH-01 and CIH-02;
- `docs/features.md` with an in-development harness entry and source/manual-test
  links;
- `harness/README.md` with the local command, prerequisites, suite-selection
  behavior, and artifact locations.

## Acceptance criteria

The design is complete when:

- one command runs the smoke suite locally on each supported OS;
- the GitHub Actions matrix runs the same command on all three hosted runners;
- CIH-01 and CIH-02 pass against source-built client and server artifacts;
- a deliberate browser assertion failure preserves trace, screenshot, logs,
  structured result, and isolated state artifacts;
- a case marked automated for the current OS cannot be silently skipped;
- all owned processes are terminated after successful and failed runs;
- the aggregation job reports a single cross-platform pass/fail result.
