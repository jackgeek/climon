# Take-control Hint Wording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shorten the displaced local-terminal hint to `Press Space to take control.` everywhere it is rendered and documented.

**Architecture:** Keep the existing two Rust rendering paths unchanged except for their shared user-facing wording. Pin the exact text in each path's existing unit tests, then update the manual-test description.

**Tech Stack:** Rust, Cargo tests, Markdown.

---

### Task 1: Pin and update the runtime hint

**Files:**
- Modify: `rust/climon-session/src/host.rs`
- Modify: `rust/climon-cli/src/client.rs`

- [ ] **Step 1: Write failing assertions**

In each existing renderer test, assert:

```rust
assert!(rendered.contains("Press Space to take control."));
assert!(!rendered.contains("and resize it to this terminal"));
```

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
cd rust
cargo test -p climon-session render_local_displaced
cargo test -p climon-cli render_local_displaced
```

Expected: both new exact-wording assertions fail against the longer hint.

- [ ] **Step 3: Apply the minimal wording change**

Replace both hint constants with:

```rust
let hint = "Press Space to take control.";
```

- [ ] **Step 4: Verify focused and full Rust tests**

Run:

```bash
cd rust
cargo test -p climon-session render_local_displaced
cargo test -p climon-cli render_local_displaced
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Expected: all commands exit successfully.

### Task 2: Update documentation and merge

**Files:**
- Modify: `docs/manual-tests/terminal-control-handoff.md`

- [ ] **Step 1: Update the manual-test wording**

Replace the long hint quotation with:

```text
Press Space to take control.
```

- [ ] **Step 2: Verify no stale runtime/documentation wording remains**

Run:

```bash
rg -n "Press Space to take control and resize it to this terminal|and resize it to this terminal" rust docs/manual-tests/terminal-control-handoff.md
```

Expected: no matches.

- [ ] **Step 3: Commit, push, and merge**

Commit with the required Copilot trailers, push the PR branch, wait for required checks, then merge PR #108 into `dev`.
