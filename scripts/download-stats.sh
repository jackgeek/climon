#!/usr/bin/env bash
#
# Print GitHub release download stats for climon.
#
# Usage:
#   scripts/download-stats.sh              # per-release totals + grand total
#   scripts/download-stats.sh --assets     # per-asset breakdown
#   REPO=owner/name scripts/download-stats.sh   # override repo
#
# Requires: gh (authenticated) and jq.

set -euo pipefail

REPO="${REPO:-jackgeek/climon}"

for cmd in gh jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: '$cmd' is required but not installed" >&2
    exit 1
  fi
done

releases_json="$(gh api "repos/${REPO}/releases" --paginate)"

if [[ "${1:-}" == "--assets" ]]; then
  printf 'TAG\tASSET\tDOWNLOADS\n'
  jq -r '.[] | .tag_name as $t | .assets[] | "\($t)\t\(.name)\t\(.download_count)"' <<<"$releases_json" \
    | { column -t -s$'\t' 2>/dev/null || cat; }
  exit 0
fi

printf 'TAG\tPUBLISHED\tDOWNLOADS\n'
jq -r '.[] | "\(.tag_name)\t\(.published_at)\t\([.assets[].download_count] | add // 0)"' <<<"$releases_json" \
  | { column -t -s$'\t' 2>/dev/null || cat; }

total="$(jq '[.[].assets[].download_count] | add // 0' <<<"$releases_json")"
echo
echo "Total asset downloads: ${total}"
