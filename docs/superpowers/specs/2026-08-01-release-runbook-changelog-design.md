# Release Runbook Changelog Step

## Goal

Prevent releases from shipping without an installer-facing entry in
`CHANGELOG.json`.

## Design

Update `docs/cutting-a-release.md` so both normal-release and hotfix procedures
explicitly require adding the new version to the top of `CHANGELOG.json` before
running `bun run release`.

Each procedure will also require validating that the edited file is valid JSON.
Keeping the instruction adjacent to the version-bump command makes the
changelog part of release preparation and ensures it is reviewed in the release
pull request.

## Scope

This is a documentation-only process correction. It does not change
`scripts/release.ts` or add automated enforcement.

## Validation

Review both release procedures to confirm the changelog step appears before the
version bump and names the correct file and validation requirement.
