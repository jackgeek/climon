# Changelog 3.3 Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add concise, historically accurate entries for releases `3.3.0` through `3.3.3` to the installer-facing changelog.

**Architecture:** Prepend four entries to the existing newest-first JSON array in `CHANGELOG.json`. Validate both JSON structure and the Bun/Rust consumers that parse and format the embedded changelog.

**Tech Stack:** JSON, Bun, Rust

---

### Task 1: Backfill the 3.3 release entries

**Files:**
- Modify: `CHANGELOG.json`
- Test: `rust/climon-install/src/changelog.rs`

- [ ] **Step 1: Add the four entries**

Prepend this content to the array in `CHANGELOG.json`:

```json
  {
    "version": "3.3.3",
    "changes": [
      "Prevent local terminals from freezing when a console write stalls by moving terminal output off the shared session-state lock",
      "Refresh Rust and JavaScript dependencies and regenerate third-party license notices"
    ]
  },
  {
    "version": "3.3.2",
    "changes": [
      "Show the terminal Select/copy button on all devices instead of limiting it to touch devices"
    ]
  },
  {
    "version": "3.3.1",
    "changes": [
      "Harden tag-driven release and back-merge automation, including workflow permissions"
    ]
  },
  {
    "version": "3.3.0",
    "changes": [
      "Make Microsoft dev-tunnel failures actionable and retry transient failures with capped backoff across dashboard and remote-session connections",
      "Fix dashboard session lists periodically going blank",
      "Copy selected captured terminal text with whitespace collapsed to a clean single line"
    ]
  },
```

- [ ] **Step 2: Validate the JSON**

Run:

```bash
bun -e 'const log=JSON.parse(await Bun.file("CHANGELOG.json").text()); const expected=["3.3.3","3.3.2","3.3.1","3.3.0"]; if (JSON.stringify(log.slice(0,4).map((x:any)=>x.version)) !== JSON.stringify(expected)) throw new Error("3.3 entries missing or out of order")'
```

Expected: exit code 0 with no output.

- [ ] **Step 3: Run the focused Rust tests**

Run from `rust/`:

```bash
cargo test -p climon-install changelog
```

Expected: all selected tests pass.

- [ ] **Step 4: Commit the backfill**

```bash
git add CHANGELOG.json
git commit -m "docs: backfill 3.3 release changelog"
```
