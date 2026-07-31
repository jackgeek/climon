# E2E Harness Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the reusable test infrastructure from “DAR harness” to “E2E harness” while retaining DAR terminology only for the current scenario suite and IDs.

**Architecture:** Apply one atomic naming migration across runtime defaults, report identities, workflow/artifact identifiers, tests, and documentation. Regression tests enforce the new generic infrastructure vocabulary without rejecting valid `DAR-01`, `DAR-02`, or `--suite dar` scenario terminology.

**Tech Stack:** TypeScript, Bun tests, GitHub Actions YAML, Markdown.

---

### Task 1: Rename runtime and reporter identities

**Files:**
- Modify: `harness/src/cli.ts`
- Modify: `harness/src/reporters/markdown.ts`
- Modify: `harness/src/reporters/junit.ts`
- Modify: `harness/tests/cli.test.ts`
- Modify: `harness/tests/reporters.test.ts`

- [ ] **Step 1: Update failing expectations**

Change expected default paths to `.test-tmp/e2e-harness/<platform>` and
`.test-tmp/e2e-harness/build`. Expect `# E2E harness summary` and JUnit suite
name `e2e-harness`.

- [ ] **Step 2: Run focused tests**

```bash
bun test harness/tests/cli.test.ts harness/tests/reporters.test.ts
```

Expected: FAIL because production code still uses DAR-specific infrastructure names.

- [ ] **Step 3: Rename production identities**

Replace infrastructure-only `dar-harness` path segments with `e2e-harness`.
Replace report display names with “E2E harness”. Do not change `DAR-01`,
`DAR-02`, `--suite dar`, scenario registry names, or scenario implementations.

- [ ] **Step 4: Run focused tests**

```bash
bun test harness/tests/cli.test.ts harness/tests/reporters.test.ts
bun run typecheck:harness
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add harness/src/cli.ts harness/src/reporters harness/tests/cli.test.ts harness/tests/reporters.test.ts
git commit -m "refactor(harness): use generic E2E identities"
```

### Task 2: Rename workflow and artifact identifiers

**Files:**
- Move: `.github/workflows/dar-e2e-harness.yml` → `.github/workflows/e2e-harness.yml`
- Modify: `harness/tests/workflow.test.ts`

- [ ] **Step 1: Update the workflow test**

Assert:

```text
name: e2e-harness
.github/workflows/e2e-harness.yml
.test-tmp/e2e-harness/${{ matrix.platform }}
e2e-harness-${{ matrix.platform }}
.test-tmp/e2e-harness-results
e2e-harness-results
```

Keep exact commands `run DAR-01 DAR-02` and `--suite dar` terminology where
scenario-specific.

- [ ] **Step 2: Run the workflow test**

```bash
bun test harness/tests/workflow.test.ts
```

Expected: FAIL because the workflow still uses DAR-specific infrastructure names.

- [ ] **Step 3: Move and rename the workflow**

Use `git mv`, update the workflow display name, trigger self-path, step names,
artifact names, artifact paths, aggregate paths, and summary fallback text.

- [ ] **Step 4: Run the workflow test**

```bash
bun test harness/tests/workflow.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows harness/tests/workflow.test.ts
git commit -m "ci: rename the E2E harness workflow"
```

### Task 3: Rename documentation and add a regression guard

**Files:**
- Modify: `harness/README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/features.md`
- Modify: `docs/manual-tests/README.md`
- Modify: `docs/manual-tests/daemon-actor-rewrite.md`
- Modify: `harness/tests/no-markdown-harness.test.ts`

- [ ] **Step 1: Add failing naming assertions**

Assert documentation contains “E2E harness”, references
`.github/workflows/e2e-harness.yml`, and uses `.test-tmp/e2e-harness/`.
Reject the infrastructure phrases `DAR harness`, `DAR Harness`,
`dar-e2e-harness`, and `.test-tmp/dar-harness`.

- [ ] **Step 2: Run documentation guards**

```bash
bun test harness/tests/no-markdown-harness.test.ts
```

Expected: FAIL on the old names.

- [ ] **Step 3: Rename documentation**

Describe DAR-01/DAR-02 as the first automated scenarios in the generic E2E
harness. Keep actor-rewrite case names and DAR identifiers unchanged. Rename
the feature catalogue row to “Cross-platform E2E harness”.

- [ ] **Step 4: Run guards and repository search**

```bash
bun test harness/tests/no-markdown-harness.test.ts
git grep -n -E 'DAR harness|DAR Harness|dar-e2e-harness|\.test-tmp/dar-harness' -- \
  ':!docs/superpowers/specs/2026-07-31-cross-platform-dar-e2e-harness-design.md' \
  ':!docs/superpowers/plans/2026-07-31-cross-platform-dar-e2e-harness.md'
```

Expected: test PASS and grep has no matches outside the historical approved design/plan.

- [ ] **Step 5: Commit**

```bash
git add harness/README.md CONTRIBUTING.md docs harness/tests/no-markdown-harness.test.ts
git commit -m "docs: rename the reusable E2E harness"
```

### Task 4: Validate the complete rename

**Files:**
- No new files.

- [ ] **Step 1: Run focused suites**

```bash
bun test harness/tests/cli.test.ts harness/tests/reporters.test.ts \
  harness/tests/workflow.test.ts harness/tests/no-markdown-harness.test.ts
bun run typecheck
bun run typecheck:harness
```

Expected: PASS.

- [ ] **Step 2: Validate commands**

```bash
bun run harness -- list
bun run harness -- doctor
```

Expected: list succeeds; doctor succeeds when Chromium is installed or reports
only the missing Chromium prerequisite.

- [ ] **Step 3: Verify repository naming**

```bash
git grep -n -E 'DAR harness|DAR Harness|dar-e2e-harness|\.test-tmp/dar-harness' -- \
  ':!docs/superpowers/specs/2026-07-31-cross-platform-dar-e2e-harness-design.md' \
  ':!docs/superpowers/plans/2026-07-31-cross-platform-dar-e2e-harness.md'
git status --short
```

Expected: no unintended matches and a clean worktree.

