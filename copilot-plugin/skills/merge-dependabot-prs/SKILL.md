---
name: merge-dependabot-prs
description: >
  Use when asked to process, triage, test, or merge open Dependabot dependency
  PRs in this repo. Retargets each Dependabot PR onto dev, runs the relevant
  gate (cargo test for Rust deps; peer-dependency check + web build + bun test
  for JS deps), squash-merges the ones that pass, and reports why any PR could
  not be merged.
---

# Merge Dependabot PRs

You are triaging every open Dependabot PR in this repository. For each PR you
will retarget it onto `dev`, run the correct test suite, and squash-merge it
only if the tests pass and it merges cleanly. At the very end you write a
summary explaining every PR that was **not** merged.

## Critical constraints (read first)

- **Never merge a Dependabot PR into `main`.** Pushing to `main` triggers the
  Release workflow. Every PR MUST be retargeted onto `dev` before merging.
- **Only merge when the tests actually pass.** A green result you did not
  observe is not a pass. If you cannot run the tests, treat the PR as not
  mergeable and record why — do not merge on faith.
- **Do not skip the summary.** Even if every PR merges, state that. If any PR
  was skipped, the summary must explain each one individually.
- Work from a clean git working tree. Record the current branch first so you
  can restore it at the end.

## Step 0: Preconditions

```sh
git rev-parse --abbrev-ref HEAD          # remember this as ORIGINAL_BRANCH
git status --porcelain                   # must be empty; if not, stop and tell the user
gh auth status                           # confirm gh is authenticated
```

If the working tree is dirty, stop and ask the user to stash or commit first —
you must not run tests against a modified tree.

## Step 1: List open Dependabot PRs

```sh
gh pr list --author "app/dependabot" --state open \
  --json number,title,headRefName,baseRefName,mergeable --limit 100
```

If the list is empty, report "No open Dependabot PRs" and stop. Otherwise
process them one at a time, oldest number first, tracking a result for each.

## Step 2: Retarget the PR onto dev

```sh
gh pr edit <number> --base dev
```

Then **verify the retarget actually took effect** and re-read mergeability
(GitHub recomputes it asynchronously, so it may briefly show `UNKNOWN`):

```sh
gh pr view <number> --json baseRefName,mergeable,mergeStateStatus
```

- `baseRefName` MUST equal `dev`. If it is still `main` (the edit failed),
  record **not merged — retarget to dev failed** and skip the PR. Never proceed
  to merge a PR whose base is `main`.
- If `mergeable` is `UNKNOWN`, wait a few seconds and re-run the command (retry
  a couple of times). If it stays `UNKNOWN`, record that and skip.
- If `mergeable` is `CONFLICTING`, record **not mergeable — merge conflicts
  against dev** and move to the next PR (do not attempt to auto-resolve
  conflicts).
- Only `mergeable: MERGEABLE` against base `dev` may continue.

## Step 3: Pick the test suite from the changed files

Dependabot separates PRs by ecosystem, encoded in the branch name:

| Branch prefix              | Ecosystem | Gate command(s) (run from repo root)                          |
| -------------------------- | --------- | ------------------------------------------------------------- |
| `dependabot/cargo/rust/…`  | Rust      | `cd rust && cargo test`                                       |
| `dependabot/bun/…`         | JS/TS     | `bun install && bun run check:peers && bun run build:web && bun test tests` |

Confirm with the actual diff when the prefix is unclear:

```sh
gh pr view <number> --json files --jq '.files[].path'
```

- Changed paths under `rust/` (e.g. `rust/Cargo.toml`, `rust/Cargo.lock`) → run
  the Rust suite.
- Changed paths at the root (e.g. `package.json`, `bun.lock`) → run the Bun
  gate (peer check + web build + tests).
- If a PR somehow touches both, run both; it passes only if everything passes.

**Grouped PRs:** Dependabot groups tightly-coupled families (`@xterm/*`,
`@fluentui/*`, `react`+`react-dom` — see `.github/dependabot.yml`) so a single PR
may bump several packages at once. `check:peers` (below) is what confirms the
group upgraded to mutually-compatible versions.

## Step 4: Check out the branch and run the gate

```sh
gh pr checkout <number>
```

Then run the command(s) chosen in Step 3.

For **Bun deps**, run the full gate — reinstall so the lockfile change is
reflected, then the peer check, the web build, and the tests, in that order:

```sh
bun install && bun run check:peers && bun run build:web && bun test tests
```

- **`check:peers` is a mandatory blocking gate.** It fails when a bump leaves a
  tightly-coupled peer behind (e.g. `@xterm/xterm` 6 with `@xterm/addon-fit` on
  0.10, whose removed-internal access silently broke terminal `fit()` — a bug the
  unit suite did not catch). If it reports any mismatch, record the PR as **not
  mergeable — peer-dependency mismatch** (quote the exact dependent → peer line)
  and skip it. Do not merge on faith.
- **`build:web` catches build-time breaks** (type/bundling regressions) the unit
  suite misses. A failed build means **not mergeable — web build failed**.

For **Rust deps**:

```sh
cd rust && cargo test
```

**Distinguish PR-caused failures from pre-existing base failures.** A test that
also fails on the target branch (`dev`) without the PR is NOT a regression from
the dependency bump — do not let it block the merge. When the suite fails:

1. Note exactly which tests failed.
2. Check out clean `dev` (`git checkout dev && git reset --hard origin/dev`),
   reinstall/rebuild, and run the same failing test(s) — for Bun,
   `bun test tests -t "<test name>"`; for Rust, `cargo test <name>`.
   (You only need to run the specific failing tests, not the whole suite.)
3. Any test that also fails on clean `dev` is **pre-existing** — ignore it for
   merge purposes (but mention it in the summary as a base-branch issue).
4. If, after excluding pre-existing failures, no failures caused by the PR
   remain, treat the suite as **passing**.

As a shortcut, two Bun tests are known to fail on `dev` regardless
(`tests/health-version.test.ts` "reports remotes enabled" and
`tests/server-remote.test.ts` ingest-shutdown timeouts), but always apply the
general rule above rather than relying only on this list.

Interpret the result:
- No PR-caused failures remain (all failures are pre-existing on `dev`) → PR is
  a **merge candidate**.
- Any failure that does NOT reproduce on clean `dev` → record **not mergeable —
  tests failed**, and capture which test(s) failed and the key error line(s) for
  the summary.

## Step 5: Merge passing PRs

Only if Step 4 passed **and** Step 2 confirmed `baseRefName: dev` with no
conflicts. Immediately before merging, **re-verify the base one last time** as a
safety check against an accidental merge into `main`:

```sh
gh pr view <number> --json baseRefName --jq '.baseRefName'   # MUST print "dev"
gh pr merge <number> --squash
```

If that check prints anything other than `dev`, STOP — do not merge; record the
PR as skipped. Confirm the merge landed (`gh pr view <number> --json state`
returns `MERGED`). If the merge command fails (e.g. required checks not
satisfied, base out of date), record the failure reason from gh's output and
move on — do not force it.

## Step 6: Restore state and move to the next PR

Running tests (especially `bun install`) may leave the working tree dirty with
lockfile changes. Discard them so the next checkout is clean:

```sh
git checkout -- . && git clean -fd    # discard test-generated changes
git checkout <ORIGINAL_BRANCH>
```

Repeat Steps 2–6 for each remaining PR. Keep the working tree clean between PRs.

## Step 7: Write the summary (always)

After every PR has been processed, restore `ORIGINAL_BRANCH` and print a
summary. List merged PRs briefly, then explain **each** unmerged PR
individually with a concrete reason. Example:

```
Dependabot triage summary
==========================

Merged (squashed into dev):
  #74  getrandom 0.1.16 → 0.4.3        (cargo test passed)
  #77  @types/node 20 → 26             (bun test passed)

Not merged:
  #70  zip 2.4.2 → 8.6.0
       cargo test failed: `climon-store` build error — `ZipArchive::new`
       signature changed (2 compile errors in rust/climon-store/src/pack.rs).
  #73  @xterm/headless 5.5.0 → 6.0.0
       merge conflicts against dev in bun.lock — needs manual rebase.
  #78  react-dom 19.2.6 → 19.2.7
       bun test failed: tests/web-terminal.test.ts (3 assertions) — not the
       known-flaky pair, looks like a real regression.
```

Give the user a one-line closing note on how many merged vs. need attention.

## Common mistakes

- **Merging into main.** Always retarget to `dev` first (Step 2). If you forget,
  you may trigger a release.
- **Assuming the branch prefix without checking a mixed diff.** Confirm with the
  file list when unsure.
- **Treating a pre-existing base failure as a PR regression** — or, conversely,
  using "it's probably pre-existing" as cover to skip verification. Always
  reproduce a failure on clean `dev` before deciding: fails on `dev` too =
  pre-existing (don't block); passes on `dev` = caused by the PR (block).
- **Skipping the peer-dependency check on JS bumps.** A green `bun test tests`
  does not prove runtime compatibility — `@xterm/xterm` 6 passed the unit suite
  while `@xterm/addon-fit` 0.10 was broken at runtime. Always run
  `bun run check:peers` (and `bun run build:web`) and block on any mismatch.
- **Skipping the summary** when everything merged, or lumping all skips into one
  vague line. Each unmerged PR needs its own explicit reason.
- **Leaving the repo on a Dependabot branch.** Always `git checkout` back to the
  original branch at the end.
