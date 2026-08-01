# Actual Release Download Stats Design

## Goal

Make `bun run stats:downloads` report product archive downloads separately from
automatic update-check traffic. A product download is a GitHub release asset
whose name matches `climon-*.zip`.

## Current Behavior

`scripts/download-stats.sh` sums every release asset. Each release contains the
five platform ZIP archives, their detached `.sig` files, and `manifest.json`.
Because clients periodically fetch the manifest, the current total mixes update
checks with archive downloads and does not represent installations or updates.

## Design

Keep the existing Bash script and GitHub API request. Classify assets by
filename in the `jq` aggregation:

- `climon-*.zip` contributes to actual downloads.
- `manifest.json` contributes to manifest requests.
- Detached signatures and any other assets contribute to neither headline
  metric.

The default table will contain:

```text
TAG  PUBLISHED  DOWNLOADS  MANIFEST_REQUESTS
```

Each release row reports zero when it has no matching asset. The footer will
report separate grand totals for actual downloads and manifest requests.

The existing `--assets` mode remains a raw per-asset view. It continues to show
every asset and its GitHub download count so maintainers can inspect signatures
or diagnose unexpected release contents.

## Data Flow

1. Validate that `gh` and `jq` are installed.
2. Fetch all releases from `repos/${REPO}/releases` with pagination.
3. For each release, select matching ZIP and manifest assets and sum their
   `download_count` values independently.
4. Format the rows with `column` when available, retaining the existing plain
   text fallback.
5. Sum the same two classifications across all releases for the footer.

The `REPO` override and authenticated `gh` behavior remain unchanged.

## Error Handling

Existing fail-fast behavior remains in place. Missing dependencies, GitHub API
failures, and malformed JSON cause a non-zero exit. Releases without assets or
without a matching classification produce zero rather than failing.

## Testing

Validate the script without network access by putting fake `gh` and `column`
executables first on `PATH`. The fake GitHub command returns fixture release
JSON containing ZIPs, signatures, a manifest, unrelated assets, and a release
with no matching assets.

The fixture-driven check will verify:

- only `climon-*.zip` counts as actual downloads;
- `manifest.json` is reported separately;
- signatures and unrelated assets are excluded from headline totals;
- empty classifications produce zero;
- grand totals use the same classification as release rows; and
- `--assets` still exposes the raw per-asset counts.

Run `bash -n` as a separate syntax check. No Bun regression test or full
application test suite is required for this isolated maintainer script change.

## Documentation Scope

Update the script usage comments to describe the revised output. No feature
catalogue or manual-test entry is required because this is a maintainer utility,
not shipped client, server, dashboard, or PWA behavior.
