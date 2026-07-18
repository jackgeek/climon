# Cutting a release

climon follows a **gitflow** branch model with **tag-driven releases**. Day-to-day
work lands on `dev`; `main` only ever holds released commits; and a release ships
**only** when a `vX.Y.Z` tag is pushed. Merging to `main` no longer cuts a release
on its own — the tag is the single, explicit ship signal.

This document is the runbook. For the branch conventions it builds on, see the
["Contributing"](../README.md#contributing) section of the README.

## Branch model at a glance

| Branch          | Purpose                                                        |
| --------------- | ------------------------------------------------------------- |
| `dev`           | Integration branch. All feature/fix PRs target it (squash).   |
| `main`          | Released code only. Never receives feature PRs directly.      |
| `release/x.y.z` | Short-lived branch to prepare a normal release off `dev`.     |
| `hotfix/x.y.z`  | Short-lived branch to patch a shipped release off `main`.     |

The version bump lives on the `release/*` (or `hotfix/*`) branch as an ordinary
commit, so it flows through the normal merge + back-merge instead of being pushed
onto `main` by CI. This is what keeps `main` and `dev` from drifting apart and
avoids the CLI-fixture merge conflicts that a CI-authored bump used to cause.

## What triggers a release

The [`Release`](../.github/workflows/release.yml) workflow runs **on a pushed tag
matching `v*`** and nothing else. It:

1. **`version`** — derives the version from the tag and fails fast unless
   `package.json` and both CLI fixtures (`fixtures/cli/version.txt`,
   `fixtures/cli/help.txt`) already embed that exact version. Also requires the
   `APPLICATIONINSIGHTS_CONNECTION_STRING` secret.
2. **`verify-signing-key`** — confirms `CLIMON_UPDATE_PRIVATE_KEY` matches the
   public key embedded in the client (canonical repo only).
3. **`build-client`** — cross-compiles the Rust `climon` client for all five
   targets with `CLIMON_VERSION` pinned to the tag.
4. **`release`** — assembles the five zips, signs them, verifies, and publishes
   the GitHub Release for the tag.
5. **`backmerge`** — opens a `main` → `dev` pull request so the bump flows back to
   the integration branch. It is **not** auto-merged; a human reviews and merges
   it with a real merge commit.

Because the tag is the trigger, an ordinary `dev` → `main` merge (or any other
push to `main`) does **not** ship anything until you tag.

## Normal release (from `dev`)

Run these from a worktree, per the repo workflow convention.

```bash
# 1. Cut a release branch off the latest dev.
git fetch origin
git worktree add .worktrees/release-x.y.z -b release/x.y.z origin/dev
cd .worktrees/release-x.y.z

# 2. Bump the version + CLI fixtures in lockstep. Picks the level explicitly:
#    patch (default), minor, or major. This commits `chore(release): vX.Y.Z`
#    and creates a local tag, but does NOT push.
bun run release            # or: bun run release minor / major

# 3. Push the release branch and open a PR into main.
#    NOTE: the local tag from step 2 is deleted below and re-created on main.
git push -u origin release/x.y.z
gh pr create --base main --head release/x.y.z \
  --title "release: vX.Y.Z" --body "Release vX.Y.Z"
```

Wait for `rust-ci` and `bun-ci` to pass on the PR, then:

```bash
# 4. Merge the release PR into main with a REAL MERGE COMMIT (never squash),
#    so main and dev keep a shared ancestor.
gh pr merge release/x.y.z --merge

# 5. Tag the merged commit on main and push the tag — THIS ships the release.
git fetch origin main
git tag -a vX.Y.Z origin/main -m "vX.Y.Z"   # tag the main merge commit
git push origin vX.Y.Z
```

> The local tag `bun run release` created points at the release-branch commit, not
> the `main` merge commit. Delete it (`git tag -d vX.Y.Z`) before step 5 if it
> would collide, and always tag `origin/main` so the release builds from the
> commit that actually landed on `main`.

Then finish up:

```bash
# 6. Watch the release workflow.
gh run watch --workflow release.yml

# 7. Merge the automated `main -> dev` back-merge PR (real merge commit) so the
#    version bump reaches dev.
gh pr list --base dev --head main
gh pr merge <pr-number> --merge
```

## Hotfix release (from `main`)

Same shape, branched off `main` instead of `dev`:

```bash
git fetch origin
git worktree add .worktrees/hotfix-x.y.z -b hotfix/x.y.z origin/main
cd .worktrees/hotfix-x.y.z

# fix the bug, commit it, then bump:
bun run release            # patch bump

git push -u origin hotfix/x.y.z
gh pr create --base main --head hotfix/x.y.z --title "hotfix: vX.Y.Z" --body "…"
# after CI + review:
gh pr merge hotfix/x.y.z --merge
git fetch origin main
git tag -a vX.Y.Z origin/main -m "vX.Y.Z" && git push origin vX.Y.Z
# then merge the automated main -> dev back-merge PR.
```

## Prerequisites and guards

- **Secrets (canonical repo):** `APPLICATIONINSIGHTS_CONNECTION_STRING` (required —
  the release fails without it) and `CLIMON_UPDATE_PRIVATE_KEY` (required for
  signed auto-update artifacts). See [docs/deployment.md](deployment.md).
- **Branch protection:** if `main` forbids direct pushes, the release workflow no
  longer needs push access to `main` (it only publishes the release and opens a
  PR). The `backmerge` job needs a token that can open PRs — the default
  `GITHUB_TOKEN` suffices, or set `RELEASE_TOKEN` for org policies that require it.
- **Version/tag mismatch:** the `version` job aborts the release if the tag does
  not match `package.json` and the CLI fixtures. If it fails, you almost certainly
  forgot `bun run release` on the branch, or tagged the wrong commit. Fix the tree,
  delete and re-push the tag.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Release job fails at `version` with a mismatch error | Tag ≠ `package.json`/fixtures. Run `bun run release`, re-tag the merged `main` commit. |
| No back-merge PR appeared | `dev` already contains `main` (nothing to merge), or an open `main → dev` PR already exists. |
| Want to re-run a failed release | Re-push the same tag (`git push -f origin vX.Y.Z` after re-pointing it) — the workflow re-runs and `gh release upload --clobber` replaces assets. |
