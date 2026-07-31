# DAR harness

Repo-local automation for the daemon-actor release gate. It currently exercises
`DAR-01` and `DAR-02` from
[`docs/manual-tests/daemon-actor-rewrite.md`](../docs/manual-tests/daemon-actor-rewrite.md)
and writes machine-readable results for local debugging and CI aggregation.

## Prerequisites

- Run from an isolated repo worktree under `.worktrees/`; the harness builds the
  branch-local Rust client, Bun server, and Rust fixture.
- Bun `1.3.10`, Node `24`, stable Rust (`cargo`, `rustc`), and local
  dependencies installed via `bun install --frozen-lockfile`.
- Playwright Chromium installed with `bun run harness:install-browser`
  (macOS/Windows) or `bunx playwright install --with-deps chromium` on Linux
  CI-style hosts.

## Commands

```bash
bun run harness -- doctor
bun run harness list
bun run harness -- run DAR-01 DAR-02 --artifact-root .test-tmp/dar-harness/<platform>
bun run harness -- aggregate --results-root .test-tmp/dar-harness-results
```

## Artifact layout

- Per run: `<artifact-root>/results.json`, `summary.md`, `junit.xml`
- Per case: `<artifact-root>/cases/DAR-0X/`
- CI matrix convention: `.test-tmp/dar-harness/<platform>/`
- CI aggregate convention: `.test-tmp/dar-harness-results/`

Case folders carry `result.json`, logs, browser traces, server state snapshots,
and any scenario-specific evidence.

Markdown docs never configure executable tests. The manual DAR docs describe
coverage and release-gate scope, while the typed scenario registry, harness CLI,
and GitHub Actions workflow define what actually runs.

## Outcome governance

Typed scenario definitions live in
[`harness/src/scenario-registry.ts`](src/scenario-registry.ts). Each scenario
declares its DAR id, manual heading, timeout, and per-platform expectation.
Expectation handling lives in
[`harness/src/expectations.ts`](src/expectations.ts): `pass` must stay green,
`known-failure` / `partial` require `tracking`, `reviewAfter`, and an exact
failed-subcheck allowlist, and `unsupported` stays non-blocking.

## Add a typed scenario

1. Add the manual case and heading to
   [`docs/manual-tests/daemon-actor-rewrite.md`](../docs/manual-tests/daemon-actor-rewrite.md).
2. Extend `DarId`, `SCENARIO_DEFINITIONS`, and validation in
   [`harness/src/scenario-registry.ts`](src/scenario-registry.ts).
3. Implement the scenario in `harness/src/scenarios/` and add focused
   `bun:test` coverage under `harness/tests/`.
4. Update the typed scenario registry, workflow, and docs if CI should execute
   the new scenario; Markdown alone never makes a case runnable.

## Debugging

- Start with `bun run harness -- doctor`; it checks toolchain, Chromium, fixture
  manifest, and scenario/manual wiring.
- Run one or more DAR ids locally: `bun run harness -- run DAR-01 DAR-02 --artifact-root .test-tmp/dar-harness/<platform>`
- Inspect `summary.md`, `junit.xml`, and per-case `logs/`, `home/`, and
  `browser-trace.zip` artifacts before re-running.
- Re-aggregate downloaded CI artifacts locally with
  `bun run harness -- aggregate --results-root .test-tmp/dar-harness-results`.

## Native `node-pty` notes

The CLI entrypoint runs
[`prepareNodePty`](src/node-pty-preflight.ts) before loading the harness. On
non-Windows hosts it fixes executable bits on
`node_modules/node-pty/prebuilds/*/spawn-helper`. Linux GitHub-hosted runners
still need `CLIMON_DISABLE_SETSID=1` during `bun run harness -- run DAR-01 DAR-02`.
