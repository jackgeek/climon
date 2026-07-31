# E2E harness naming design

## Goal

Name the reusable cross-platform test infrastructure the **E2E harness**. DAR is
only the first scenario suite; future non-DAR scenarios must fit without a
misleading product name.

## Naming contract

- User-facing prose uses “E2E harness”.
- The command remains `bun run harness`.
- Workflow and artifact identifiers use `e2e-harness`.
- Default artifacts live under `.test-tmp/e2e-harness/`.
- Aggregate inputs and outputs live under `.test-tmp/e2e-harness-results/`.
- Markdown reports are titled “E2E harness summary”.
- JUnit uses the suite name `e2e-harness`.
- DAR remains in `DAR-01`, `DAR-02`, the `dar` suite selector, actor rewrite
  manual-test prose, and scenario-specific implementation names.

## Repository changes

Rename the workflow file and update workflow triggers, artifact names, tests,
documentation, feature catalogue text, reporter snapshots, CLI defaults, and
all examples. Update regression tests to reject obsolete “DAR harness” and
`dar-harness` infrastructure naming while allowing DAR scenario terminology.

## Compatibility

No compatibility alias is retained for the unmerged harness. The CLI command
and scenario IDs do not change.

