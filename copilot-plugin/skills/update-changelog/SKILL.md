---
name: update-changelog
description: >
  Examine commits since the last version in CHANGELOG.json and add a new entry
  with user-friendly change descriptions for the upcoming release.
---

# Update Changelog

You are updating the `CHANGELOG.json` file in this repository. Follow these steps precisely:

## Step 1: Determine the latest version in CHANGELOG.json

Read `CHANGELOG.json` at the repo root. The first entry's `version` field is the most recent released version. Call this `LAST_VERSION`.

## Step 2: Determine the next version

Read `package.json` to get the current version. If it matches `LAST_VERSION`, the release hasn't been bumped yet — ask the user what bump level to use (patch/minor/major) and compute the next version. If it's already ahead of `LAST_VERSION`, use the `package.json` version as the new entry's version.

**When you bump the version, bump it with `bun run release` (preferred) so `package.json` and the golden CLI fixtures move together. If you edit `package.json` by hand instead, you MUST also rewrite the `climon v<semver>` token on line 1 of both `fixtures/cli/version.txt` and `fixtures/cli/help.txt` — otherwise `rust/climon-cli/tests/cli_fixtures.rs` (and CI) fails on a version mismatch.**

## Step 3: Get commits since the last version

Run:
```
git log --oneline v{LAST_VERSION}..HEAD --no-merges
```

If the tag doesn't exist, try:
```
git log --oneline --all --grep="chore(release): v{LAST_VERSION}" --format="%H" | head -1
```
Then use that commit hash as the base.

## Step 4: Filter and summarize changes

From the commit list, **include** commits that are user-facing:
- `feat:` / `feat(...):`  — new features
- `fix:` / `fix(...):`   — bug fixes that affect user behavior
- Commits without conventional prefixes that clearly describe user-visible changes

**Exclude** commits that are internal-only:
- `chore:` — release bumps, dependency updates, CI changes
- `test:` — test-only changes
- `docs:` — documentation-only changes (unless they describe a new user-facing capability)
- `refactor:` — internal restructuring with no user-visible effect
- `ci:` — CI/workflow changes

## Step 5: Write user-friendly descriptions

Transform each included commit into a concise, user-friendly description:
- Write in imperative or descriptive form (e.g., "Add Linux installer" not "Added linux installer")
- Remove scope prefixes — integrate the scope into the description naturally
- Group related commits into a single entry when they implement one feature across multiple commits
- Keep each entry to one line, under 80 characters when possible
- Focus on **what changed for the user**, not implementation details

## Step 6: Add the entry to CHANGELOG.json

Insert a new entry at the **top** of the JSON array:

```json
[
  {
    "version": "X.Y.Z",
    "changes": [
      "Description of change 1",
      "Description of change 2"
    ]
  },
  ... existing entries ...
]
```

## Step 7: Verify

- Ensure the JSON is valid (no trailing commas, proper quoting)
- Ensure the version is strictly `X.Y.Z` format
- Ensure entries are ordered newest-first
- If the version changed, confirm `fixtures/cli/version.txt` and `fixtures/cli/help.txt` line 1 report the new `climon v<semver>`, then run `cargo test -p climon-cli --test cli_fixtures` (from `rust/`) to confirm the CLI fixtures match the binary
- Run `bun test tests/changelog.test.ts` to confirm nothing is broken

## Example

Given these commits:
```
abc1234 feat(web): add dark mode toggle
def5678 fix: terminal flickering on resize
ghi9012 chore(release): v0.9.1
jkl3456 test: cover dark mode rendering
mno7890 feat(cli): support --watch flag for live reload
```

Produce:
```json
{
  "version": "0.9.2",
  "changes": [
    "Add dark mode toggle to the dashboard",
    "Fix terminal flickering on resize",
    "Support --watch flag for live reload"
  ]
}
```
