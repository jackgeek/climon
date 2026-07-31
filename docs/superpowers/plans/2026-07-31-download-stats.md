# Actual Release Download Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bun run stats:downloads` count only platform ZIP archives as actual downloads while reporting manifest requests separately.

**Architecture:** Keep the existing Bash/GitHub API implementation and classify release assets by filename inside `jq`. Validate the real script without network access by placing fake `gh` and `column` commands on `PATH` and checking deterministic fixture output.

**Tech Stack:** Bash, GitHub CLI API shape, `jq`

---

## File Structure

- Modify `scripts/download-stats.sh`: classify `climon-*.zip` and
  `manifest.json` independently in release rows and grand totals while
  preserving the raw `--assets` view.

### Task 1: Separate actual downloads from manifest requests

**Files:**
- Modify: `scripts/download-stats.sh:3-38`

- [ ] **Step 1: Implement filename-based classification**

Update the usage comments and replace the default aggregation/footer in
`scripts/download-stats.sh` with:

```bash
# Usage:
#   scripts/download-stats.sh              # ZIP downloads + manifest requests
#   scripts/download-stats.sh --assets     # raw per-asset breakdown
#   REPO=owner/name scripts/download-stats.sh   # override repo
```

Keep dependency validation, release fetching, and the `--assets` block
unchanged. Replace the code after that block with:

```bash
printf 'TAG\tPUBLISHED\tDOWNLOADS\tMANIFEST_REQUESTS\n'
jq -r '
  .[] |
  [
    .tag_name,
    .published_at,
    ([.assets[]? | select(.name | test("^climon-.*\\.zip$")) | .download_count] | add // 0),
    ([.assets[]? | select(.name == "manifest.json") | .download_count] | add // 0)
  ] |
  @tsv
' <<<"$releases_json" \
  | { column -t -s$'\t' 2>/dev/null || cat; }

actual_total="$(
  jq '[.[] | .assets[]? | select(.name | test("^climon-.*\\.zip$")) | .download_count] | add // 0' \
    <<<"$releases_json"
)"
manifest_total="$(
  jq '[.[] | .assets[]? | select(.name == "manifest.json") | .download_count] | add // 0' \
    <<<"$releases_json"
)"

echo
echo "Total actual downloads: ${actual_total}"
echo "Total manifest requests: ${manifest_total}"
```

The anchored ZIP expression counts `climon-linux-x64.zip` but not
`climon-linux-x64.zip.sig`. The optional asset iterator (`.assets[]?`) makes
releases with absent or empty asset arrays produce zero.

- [ ] **Step 2: Check the shell script syntax**

Run:

```bash
bash -n scripts/download-stats.sh
```

Expected: exit code 0 with no output.

- [ ] **Step 3: Validate default output with fixture release data**

Create temporary fake `gh` and `column` executables outside the repository. The
fake `gh` must return three releases:

- `v3.3.3`: ZIP counts 7 and 11, ZIP signature count 20, manifest count 100,
  and unrelated asset count 50.
- `v3.3.2`: manifest count 5 and ZIP signature count 9, with no ZIP.
- `v3.3.1`: no `assets` property.

Run the real script with the temporary directory first on `PATH`. Verify the
tab-separated output contains:

```text
TAG	PUBLISHED	DOWNLOADS	MANIFEST_REQUESTS
v3.3.3	2026-07-30T12:00:00Z	18	100
v3.3.2	2026-07-20T12:00:00Z	0	5
v3.3.1	2026-07-10T12:00:00Z	0	0

Total actual downloads: 18
Total manifest requests: 105
```

Also verify the output does not contain `Total asset downloads`.

- [ ] **Step 4: Validate the raw asset view**

Run the real script with `--assets` against the same fake dependencies. Verify
the output still contains:

```text
TAG	ASSET	DOWNLOADS
v3.3.3	climon-linux-x64.zip.sig	20
v3.3.3	release-notes.txt	50
```

- [ ] **Step 5: Commit the implementation**

```bash
git add scripts/download-stats.sh
git commit -m "fix: report actual release downloads" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 4c4615e1-0f7f-433d-a833-b5c783131f54"
```
