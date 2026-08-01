# Release Runbook Changelog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require every normal and hotfix release to add and validate its installer-facing changelog entry before the version bump.

**Architecture:** Make a documentation-only change to the two release procedures in `docs/cutting-a-release.md`. Place the changelog instruction immediately before `bun run release` so the release commit and pull request include the reviewed entry.

**Tech Stack:** Markdown, JSON, Bun

---

### Task 1: Add changelog preparation to both release procedures

**Files:**
- Modify: `docs/cutting-a-release.md`

- [ ] **Step 1: Update the normal-release procedure**

Insert a step before the version bump that instructs the releaser to add the new
version at the top of `CHANGELOG.json` and run:

```bash
bun -e 'JSON.parse(await Bun.file("CHANGELOG.json").text())'
```

- [ ] **Step 2: Update the hotfix procedure**

Add the same changelog edit and JSON validation instructions before
`bun run release` in the hotfix command sequence.

- [ ] **Step 3: Validate the documentation**

Run:

```bash
git diff --check
bun -e 'JSON.parse(await Bun.file("CHANGELOG.json").text())'
```

Expected: both commands exit successfully with no output.

- [ ] **Step 4: Commit the runbook correction**

```bash
git add docs/cutting-a-release.md
git commit -m "docs: require changelog updates when cutting releases"
```
