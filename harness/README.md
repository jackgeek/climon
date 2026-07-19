# climon client/server CI harness

## Purpose

End-to-end gate that builds the **Rust `climon` client** and the **compiled Bun
server** from one checkout, then exercises them together using
[Playwright Test](https://playwright.dev) on macOS, Linux, and Windows CI.

Two smoke scenarios are validated:

| Scenario key | What it does |
|---|---|
| `client-server.headless-dashboard` | Runs `climon run --headless`, opens the dashboard in headless Chromium, sends a PING command via the dashboard terminal, waits for the echo, confirms exit code 0 |
| `client-server.attached-pty` | Runs `climon run` through a node-pty pseudo-terminal, waits for the dashboard to reflect the session, sends a PING, confirms exit and metadata |

All test cases are selected exclusively from validated `yaml harness` metadata
blocks in `docs/manual-tests/cross-platform-ci-harness.md`.

## Prerequisites

| Tool | Version |
|---|---|
| [Bun](https://bun.sh) | 1.3.10 |
| Rust (stable toolchain) | stable |
| Node.js | 24 |
| Chromium | installed via `bun run harness:install-browser` |

## Install

```bash
bun install
bun run harness:install-browser
```

## Run

```bash
# Unit tests only (catalogue, platform, artifact, build, environment, aggregate)
bun run test:harness:unit

# Smoke tests only (CIH-01 headless-dashboard, CIH-02 attached-pty)
bun run test:harness:smoke

# All harness tests
bun run test:harness
```

All three commands run `harness:prepare-native` first (compiles the
`node-pty` native binding for the current platform) before delegating to
`playwright test --config harness/playwright.config.ts`.

## Test selection

Cases are loaded from `yaml harness` blocks in `docs/manual-tests/`. The
catalogue (`harness/src/catalog.ts`) parses and validates each block; only the
following fields are accepted:

```yaml
status: automated
suite: smoke
scenario: client-server.headless-dashboard   # must match a ScenarioKey
platforms: [macos, linux, windows]
timeoutSeconds: 120
```

Unknown fields are a catalogue validation error. The `scenario` value must
resolve to a registered key in `SCENARIOS` (`harness/src/scenarios.ts`);
unresolvable keys are rejected at startup. No commands, selectors, or
arbitrary code may appear in Markdown metadata.

## Artifacts

Artifacts land under `.test-tmp/harness/<platform>/` (overridable via
`CLIMON_HARNESS_ARTIFACT_DIR`):

```
.test-tmp/harness/<platform>/
├── playwright/             ← Playwright trace/screenshots (failure only)
├── playwright-results.json ← Full Playwright JSON report
└── cases/
    └── <case-id>/
        ├── result.json         ← CaseResult: id, platform, status, durationMs,
        │                         failureKind?, message?
        ├── summary.md          ← Human-readable case summary
        ├── headless-stdout.log ← Client stdout (CIH-01)
        ├── headless-stderr.log ← Client stderr (CIH-01)
        ├── pty.log             ← PTY output (CIH-02)
        └── home-snapshot/      ← CLIMON_HOME file tree snapshot on failure
```

Environment variables containing `token`, `secret`, `password`, `connection`,
`string`, or `key` (case-insensitive) are redacted in serialized state.

Cross-platform results are merged by `harness/src/aggregate.ts`
(`bun run harness:aggregate`), which fails the aggregate gate if any platform
has a failing case.

## Adding a scenario

1. Add the new key to the `ScenarioKey` union in `harness/src/types.ts`.
2. Implement the scenario function in `harness/src/scenarios.ts` and register
   it in the `SCENARIOS` map.
3. Add a unit test in `harness/tests/scenarios.spec.ts` covering the
   implementation with fakes.
4. Add a manual-test Markdown file under `docs/manual-tests/` with a
   `yaml harness` block whose `scenario` matches the new key.
5. Verify the catalogue accepts the new block:
   ```bash
   bun run test:harness:unit
   ```

## Safety

- Each run creates an **isolated `CLIMON_HOME`** (under `.test-tmp/harness/`),
  preventing any interaction with the developer's real sessions or config.
- Only `harness/fixtures/echo-session.mjs` runs inside sessions; it accepts
  only `PING <token>` and `EXIT <code>` commands and echoes `CIH_ECHO <token>`.
- Session IDs are tracked and cleaned up at the end of each test; cleanup uses
  PID- and session-scoped operations and **never kills processes by name**.
- The harness does not modify the host system's PATH, shell config, or any
  file outside the isolated `CLIMON_HOME` and the `.test-tmp/` artifact tree.
