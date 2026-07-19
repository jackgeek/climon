# Cross-platform client/server harness handoff

## Current state

The harness is implemented on PR [#148](https://github.com/jackgeek/climon/pull/148),
which targets `dev` from `design/idiomatic-daemon-rewrite-harness`.

At commit `a6927be75bdf3305c7d0e526cc4c8a32e4c6f242`:

- the macOS, Linux, and Windows smoke jobs pass;
- the cross-platform aggregate job passes;
- Bun CI, Rust CI on all three operating systems, and license checks pass;
- the final whole-branch review found no significant issues;
- the PR remains open and has not been merged.

The current smoke suite contains:

| Case | Scenario key | Coverage |
|---|---|---|
| CIH-01 | `client-server.headless-dashboard` | Detached client, daemon, PTY, metadata, server, browser terminal input/output, and finalization |
| CIH-02 | `client-server.attached-pty` | Attached client in `node-pty`, dashboard replay, local PTY input/output, clean exit, and finalization |

## Purpose and trust boundary

The harness builds the shipping Rust client and maintained Bun server from one
checkout, starts them in an isolated environment, and drives the dashboard with
Playwright Test. It is intended for deterministic integration and end-to-end
coverage, not subjective visual testing.

Manual-test Markdown is the catalogue, not an executable test language. A
`yaml harness` block may select a reviewed TypeScript scenario and bounded
metadata, but it must never provide commands, scripts, selectors, or arbitrary
code.

Supported metadata fields are:

```yaml
status: automated
suite: smoke
scenario: client-server.headless-dashboard
platforms: [macos, linux, windows]
timeoutSeconds: 120
```

Unknown fields, unknown scenarios, duplicate IDs, duplicate platforms, and
timeouts outside 1–600 seconds are catalogue errors.

## Architecture map

| Area | File | Responsibility |
|---|---|---|
| Catalogue | `harness/src/catalog.ts` | Scans `docs/manual-tests/*.md`, validates metadata, and produces `HarnessCase` records |
| Types | `harness/src/types.ts` | Scenario keys, platforms, case/result shapes, failure classifications |
| Scenario registry | `harness/src/scenarios.ts` | Reviewed executable implementations selected by catalogue keys |
| Environment | `harness/src/environment.ts` | Isolated `CLIMON_HOME`, source builds, server lifecycle, session tracking, state snapshots, cleanup |
| Command runner | `harness/src/command.ts` | Shell-free process execution, bounded waits, output capture, owned-tree termination |
| PTY driver | `harness/src/pty.ts` | Attached client execution through `node-pty` |
| Dashboard driver | `harness/src/dashboard.ts` | Stable dashboard navigation, session/status waits, terminal input/output |
| Artifacts | `harness/src/artifacts.ts` | Per-case results, summaries, redacted state snapshots |
| Dynamic runner | `harness/tests/smoke.spec.ts` | Selects catalogue cases for the current OS and executes registered scenarios |
| Unit coverage | `harness/tests/*.spec.ts` | Catalogue, scenario helpers, drivers, environment, build, artifacts, and aggregation |
| CI matrix | `.github/workflows/client-server-harness.yml` | macOS/Linux/Windows jobs, evidence upload, aggregate gate |
| Manual cases | `docs/manual-tests/cross-platform-ci-harness.md` | Human-readable CIH-01 and CIH-02 plans plus harness metadata |

The runtime flow is:

1. Playwright loads and validates the manual-test catalogue.
2. A worker-scoped `HarnessEnvironment` resets only its runtime directory.
3. The environment builds the Rust client and Bun server from the checkout.
4. It creates an isolated `CLIMON_HOME`, disables telemetry/update/remotes, and
   starts the server on loopback port `0`.
5. It waits for matching `server.json` PID/port data and a successful `/health`.
6. A scenario starts the deterministic fixture through the real client.
7. The PTY and/or dashboard driver exchanges sentinel input and output.
8. The scenario verifies dashboard and persisted metadata state.
9. The runner writes results and snapshots state.
10. Worker teardown waits for tracked sessions, terminates only owned process
    trees, and stops the server.

## Adding a new scenario

### 1. Start from a manual test

Add or update a case under `docs/manual-tests/` using the standard manual-test
shape: heading, matching `ID`, preconditions, numbered steps, expected result,
platforms, and result-tracking row.

Put the `yaml harness` block directly below the case fields. Use a stable,
descriptive scenario key. Do not encode implementation details in Markdown.

Example:

````markdown
## CIH-03 — Non-zero exit lifecycle

- **ID:** CIH-03
- **Feature / phase:** Failed-session finalization
- **Platforms:** macOS, Linux, Windows

```yaml harness
status: automated
suite: smoke
scenario: client-server.nonzero-exit
platforms: [macos, linux, windows]
timeoutSeconds: 120
```
````

Also link a new manual-test file from `docs/manual-tests/README.md`.

### 2. Register the key in both type and catalogue validation

Add the key to:

- `ScenarioKey` in `harness/src/types.ts`;
- the `SCENARIOS` validation set in `harness/src/catalog.ts`.

These are intentionally separate. The type protects TypeScript call sites;
catalogue validation rejects unreviewed Markdown keys before execution.

### 3. Implement and register the scenario

Add the implementation to `harness/src/scenarios.ts` and register it in the
exported `SCENARIOS` map.

Use the provided `ScenarioContext`:

```ts
interface ScenarioContext {
  caseDefinition: HarnessCase;
  environment: HarnessEnvironment;
  dashboard: DashboardDriver;
  page: Page;
  artifactDir: string;
}
```

Follow these rules:

- launch executables with file/argument arrays; never build a shell command;
- use `environment.runtimeEnv` so the isolated home and deterministic terminal
  dimensions propagate;
- call `environment.trackSession(id)` as soon as the session ID is known;
- write scenario-specific logs inside `artifactDir`;
- throw `HarnessError` with the most accurate failure kind;
- use condition-based waits on observable state, not fixed sleeps;
- verify both the user-visible state and persisted metadata when the behavior
  crosses both surfaces;
- release scenario-owned resources in `finally`.

If multiple scenarios need the same operation, add a focused method to a driver
or extract a small helper rather than duplicating Playwright or process logic.

### 4. Extend the deterministic fixture only when necessary

The existing `harness/fixtures/echo-session.mjs` deliberately accepts only:

- `PING <token>`;
- `EXIT <code>`.

Prefer reusing it for lifecycle, replay, input routing, take-control, resize,
and exit-state tests. If a feature requires title, progress, attention, or
screen-shape output, either extend the fixture with a small allowlisted command
or add a separate narrowly scoped fixture.

Do not run arbitrary shell scripts as fixtures. Avoid prompts, locale-sensitive
text, terminal-dependent commands, and timing-based behavior.

### 5. Add focused unit coverage

Update `harness/tests/scenarios.spec.ts` so:

- the expected `ScenarioKey` list includes the new key;
- the registry-size expectation is updated;
- extracted scenario helpers are tested with fakes;
- safety properties are explicit, such as an attached-viewer helper not being
  able to click or take control.

Add or update driver tests when introducing a new driver method. Catalogue
tests should cover any new valid case and malformed form. Test failure
classification and cleanup behavior when the scenario adds a new failure path.

### 6. Decide whether the test belongs in `smoke`

`harness/tests/smoke.spec.ts` currently selects only `suite: smoke`. Keep smoke
cases bounded and release-gating:

- deterministic on all declared platforms;
- normally under two minutes per case;
- independent of external accounts, tunnels, notifications, or public network
  services;
- safe to run repeatedly on one checkout.

For a broader or slower suite, add a separate Playwright spec and package script
instead of silently expanding smoke into a long system test. Reuse the same
catalogue, environment, result, and artifact primitives.

## Dashboard automation guidance

Prefer stable semantic selectors. Existing selectors are:

- `[data-testid="session-list"]`;
- `[data-testid="session-item"][data-session-id="..."]`;
- `[data-testid="open-terminal-button"]`;
- `[data-testid="session-terminal"]`;
- `data-session-status` on session items.

Add a `data-testid` only to a semantic control or state boundary, not a layout
container chosen for CSS convenience.

Important control rule: CIH-02 treats the browser as a passive viewer. It waits
for the auto-selected terminal and must not click the session or Open terminal
button, because those paths may arm take-control and displace the attached PTY.
New control-handoff tests should make that transition explicit rather than
reusing the passive-viewer helper.

`DashboardDriver` already captures browser console messages and failed requests.
If a scenario fails in a browser-specific way, include those collections in the
error or add them to the case artifact before throwing.

## Process, state, and artifact rules

Each invocation uses:

```text
.test-tmp/harness/<platform>/
├── runtime/
│   ├── home/
│   ├── build/
│   └── logs/
├── cases/<case-id>/
├── playwright/
└── playwright-results.json
```

`runtime/` is reset between invocations. Case and Playwright evidence is
preserved.

Every scenario should leave enough evidence to answer:

- Did the client start?
- Did the daemon create metadata and a socket?
- Did the server discover the session?
- Did the browser connect?
- Which terminal bytes were observed?
- Did the command exit?
- Did metadata reach the expected terminal state?
- Did cleanup complete?

Use the existing `FailureKind` values:

| Kind | Use for |
|---|---|
| `catalogue` | Invalid manual-test metadata or scenario resolution |
| `build` | Source artifact compilation/preparation |
| `server-startup` | Server process, `server.json`, or `/health` readiness |
| `client-startup` | Launcher failure or invalid launcher output |
| `pty` | `node-pty` spawn, I/O, or exit failure |
| `browser` | Navigation, selectors, WebSocket-visible state, terminal UI |
| `assertion` | Valid observations that do not match expected behavior |
| `timeout` | A bounded operation exceeded its deadline |
| `cleanup` | Session/process teardown or state snapshot failure |

Do not kill by executable name. Unix cleanup owns process groups; Windows uses
PID-scoped `taskkill /PID <pid> /T`. Any new long-lived process must be owned by
the environment or explicitly released by the scenario.

## Validation workflow

From the repository root:

```bash
bun install
bun run harness:install-browser

# Fast feedback for catalogue, helpers, drivers, artifacts, and aggregation
bun run test:harness:unit

# Source-build and run catalogue-selected smoke cases on the current OS
bun run test:harness:smoke

# All harness Playwright tests
bun run test:harness

# Maintained Bun server/dashboard suite
bun run test

# Rust client gates
cd rust
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The package scripts run `harness:prepare-native` first so `node-pty` is compiled
for the host OS.

Before treating a cross-platform scenario as complete, run the PR workflow and
confirm:

- `smoke (linux)`;
- `smoke (macos)`;
- `smoke (windows)`;
- `aggregate`;
- Bun CI;
- Rust CI on Ubuntu, macOS, and Windows;
- license checks.

Windows-hosted CI is authoritative for Windows runtime behavior. macOS
cross-checking can catch Rust type errors in selected crates, but it cannot
replace ConPTY execution or the MSVC build environment.

## Platform lessons

### macOS

- The local development path is representative for Unix PTY behavior.
- Keep terminal assertions independent of the developer's shell configuration.
- Source builds are shared per Playwright worker; avoid scenario-specific build
  mutations.

### Linux

- GitHub-hosted runners reject the controlling-terminal operation used by
  `setsid -c`.
- The workflow sets `CLIMON_DISABLE_SETSID=1` only on Linux. Preserve that
  environment setting unless the PTY implementation changes.
- Do not generalize this CI workaround into a product default.

### Windows

- Detached descendants can inherit the outer Node process's stdout/stderr pipe
  handles. The Rust launcher now guards standard-handle inheritance around
  detached daemon, uplink, and update spawns. A launcher process exiting does
  not prove its pipes have closed.
- Headless ConPTY emits `ESC [ 6 n`, requesting the initial cursor position,
  before starting the monitored command. With no terminal emulator attached,
  the child remains blocked. Headless session engines now prime ConPTY with the
  `ESC [ 1 ; 1 R` response through `climon_pty::prime_headless_conpty`.
- Raw `climon-pty` tests bypass the session host and must prime headless ConPTY
  themselves.
- ConPTY integration tests are serialized. Teardown can otherwise interfere
  with another concurrently running pseudoconsole.
- A headless ConPTY may report Windows status `0xC000013A` during teardown even
  after expected output was streamed. Tests retain output assertions and treat
  only that documented exit-code case as inconclusive.
- Do not add `AllocConsole` as a workaround. Investigation showed console
  allocation was not the root cause and could create visible-window regressions.

## Recommended next scenarios

### 1. Non-zero exit and failed metadata

Add `client-server.nonzero-exit`.

Run the existing fixture, send `EXIT 7`, and verify:

- terminal output includes `CIH_EXIT 7`;
- dashboard status becomes `failed`;
- persisted `exitCode` is `7`;
- final output remains available.

This is the smallest extension and validates the failure finalization path on
all three platforms.

### 2. Browser take-control and local restore

Add an attached scenario that:

1. starts in `node-pty`;
2. opens the dashboard as a passive viewer;
3. deliberately takes control in the browser;
4. sends input through the browser;
5. disconnects or yields control;
6. verifies the local terminal regains control and receives a correct repaint.

This covers the highest-risk shared-PTY behavior. It requires new explicit
dashboard methods; do not weaken `prepareAttachedTerminal`.

### 3. Resize ownership and last-viewer reversion

Exercise browser resize clamping, shared PTY metadata dimensions, and reversion
when the last browser viewer disconnects. Assert terminal dimensions through a
deterministic fixture command rather than screenshot geometry.

### 4. Attention lifecycle

Use deterministic output and a short isolated attention interval to verify:

- running to needs-attention;
- acknowledgement from the dashboard;
- metadata persistence;
- no invented wire-level Attention frame.

Keep timing bounded and condition-based. Do not depend on wall-clock sleeps
alone.

### 5. Terminal title and progress capture

Add a fixture that emits allowlisted OSC title and progress sequences. Verify
the session list, selected-session UI, and metadata agree, including clear/reset
behavior.

### 6. Multiple-session isolation

Run two deterministic sessions with distinct tokens. Verify dashboard selection,
input routing, output, exit state, and artifacts never cross session IDs. This
is especially valuable for detecting shared singleton or selector bugs.

## Extension checklist

- [ ] Manual case has a unique heading and matching `ID`.
- [ ] `yaml harness` contains only allowed fields.
- [ ] Scenario key is added to `ScenarioKey`.
- [ ] Scenario key is added to catalogue validation.
- [ ] Scenario is implemented and registered in `SCENARIOS`.
- [ ] Session IDs are tracked immediately.
- [ ] Commands are shell-free.
- [ ] Fixture behavior is deterministic and allowlisted.
- [ ] Driver methods use stable semantic selectors.
- [ ] Waits observe conditions and have bounded deadlines.
- [ ] Success checks both visible and persisted state where applicable.
- [ ] Failure uses an accurate `HarnessError` kind.
- [ ] Scenario-owned resources are released in `finally`.
- [ ] Unit tests cover helpers, registry, and safety constraints.
- [ ] Manual-test index and feature catalogue are updated if feature scope changes.
- [ ] Local harness unit and smoke tests pass.
- [ ] Hosted macOS, Linux, Windows, aggregate, Bun, Rust, and license checks pass.

## Key references

- `harness/README.md`
- `docs/manual-tests/README.md`
- `docs/manual-tests/cross-platform-ci-harness.md`
- `docs/superpowers/specs/2026-07-18-cross-platform-ci-harness-design.md`
- `docs/superpowers/plans/2026-07-18-cross-platform-ci-harness.md`
- `.github/workflows/client-server-harness.yml`
