# Rand Dependency Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve Dependabot alert 1 by replacing abandoned `human_id` with `petname 3.1` while preserving three-word lowercase session IDs.

**Architecture:** `climon-store` remains the sole owner of session-ID generation and collision handling. Only the default word generator changes: it uses `petname`'s embedded medium English lists, while the existing retry loop, metadata collision check, and validation error remain unchanged.

**Tech Stack:** Rust 2021 workspace, `petname 3.1`, Cargo, `cargo-deny`, `cargo-about`

---

## File Map

- `rust/Cargo.toml`: replace the workspace dependency declaration.
- `rust/climon-store/Cargo.toml`: consume `petname` from workspace dependencies.
- `rust/climon-store/src/session_id.rs`: generate IDs from the medium petname list and retain collision behavior.
- `rust/Cargo.lock`: resolve `petname` and patched `rand`, removing `human_id` and `rand 0.7.3`.
- `rust/THIRD-PARTY-LICENSES.md`: regenerate dependency attribution.
- `docs/manual-tests/phase05-store.md`: update the existing license-gate manual check.

### Task 1: Replace the Session-ID Generator

**Files:**
- Modify: `rust/Cargo.toml:8-15`
- Modify: `rust/climon-store/Cargo.toml:8-14`
- Modify: `rust/climon-store/src/session_id.rs:1-66`
- Modify: `rust/Cargo.lock`

- [ ] **Step 1: Replace the manifest dependency**

In `rust/Cargo.toml`, replace:

```toml
human_id = "0.1"
```

with:

```toml
petname = { version = "3.1", default-features = false, features = ["default-rng", "default-words"] }
```

In `rust/climon-store/Cargo.toml`, replace:

```toml
human_id = { workspace = true }
```

with:

```toml
petname = { workspace = true }
```

- [ ] **Step 2: Write the failing medium-list test**

In `rust/climon-store/src/session_id.rs`, replace
`returns_lowercase_adjective_noun_verb_id` with:

```rust
#[test]
fn default_generator_returns_three_lowercase_words_from_medium_list() {
    let id = default_session_id();
    let parts: Vec<&str> = id.split('-').collect();
    let words = petname::lang::english::Petnames::medium();

    assert_eq!(parts.len(), 3, "expected three segments in {id}");
    assert!(words.adverbs.contains(&parts[0]), "unknown adverb {}", parts[0]);
    assert!(
        words.adjectives.contains(&parts[1]),
        "unknown adjective {}",
        parts[1]
    );
    assert!(words.nouns.contains(&parts[2]), "unknown noun {}", parts[2]);
    for part in parts {
        assert!(!part.is_empty());
        assert!(
            part.chars().all(|c| c.is_ascii_lowercase()),
            "segment {part} not lowercase ascii"
        );
    }
}
```

- [ ] **Step 3: Run the focused test to verify it fails**

Run from `rust/`:

```bash
cargo test -p climon-store session_id::tests::default_generator_returns_three_lowercase_words_from_medium_list
```

Expected: compilation FAILS because `default_session_id` does not exist yet.

- [ ] **Step 4: Implement the medium-list generator**

In `rust/climon-store/src/session_id.rs`, replace the module documentation and default generator with:

```rust
//! Human-readable session id generation. Ports `session-id.ts`: lowercase
//! hyphen-separated ids (e.g. `rare-geckos-jam`) that re-roll on a metadata-file
//! collision, with no random-suffix fallback.

use crate::error::{StoreError, StoreResult};
use crate::paths::Env;

/// Maximum candidate ids tried before giving up. Mirrors `MAX_ATTEMPTS`.
pub const MAX_ATTEMPTS: usize = 50;

/// Generates three lowercase words from petname's medium English list.
pub fn default_session_id() -> String {
    petname::petname(3, "-").expect("petname medium word lists must not be empty")
}

/// Generates a unique session id using the default word generator.
pub fn generate_session_id(env: &Env) -> StoreResult<String> {
    generate_session_id_with(env, default_session_id)
}
```

Keep `generate_session_id_with` and its retry/error logic unchanged.

Run from `rust/` to resolve the replacement and ensure the patched release is
selected:

```bash
cargo update -p rand --precise 0.10.1
```

Expected: `Cargo.lock` adds `petname 3.1.0` and `rand 0.10.1`, and removes
`human_id 0.1.0` and `rand 0.7.3`.

- [ ] **Step 5: Run the focused store tests**

Run from `rust/`:

```bash
cargo test -p climon-store session_id::tests
```

Expected: all session-ID tests PASS.

- [ ] **Step 6: Confirm the vulnerable dependency is gone**

Run from `rust/`:

```bash
cargo tree -i petname
cargo tree -i rand@0.10.1
! cargo tree -i human_id
! cargo tree -i rand@0.7.3
```

Expected: `petname` is used by `climon-store`; patched `rand 0.10.1` is used by
`petname`; the negated commands succeed because Cargo reports that no
`human_id` or `rand 0.7.3` package matched.

- [ ] **Step 7: Commit the generator replacement**

```bash
git add rust/Cargo.toml rust/climon-store/Cargo.toml rust/climon-store/src/session_id.rs rust/Cargo.lock
git commit -m "fix(store): replace vulnerable rand dependency" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: a85e5cd8-7718-4f40-9f5c-f931e2fd1ae3"
```

### Task 2: Refresh License Documentation

**Files:**
- Modify: `rust/THIRD-PARTY-LICENSES.md`
- Modify: `docs/manual-tests/phase05-store.md:243-263`

- [ ] **Step 1: Update the manual license check**

Change the test title to:

```markdown
## MT-P5-08 — License gate + attribution freshness (`petname` dependency)
```

Change step 1's dependency note to:

```markdown
   (`petname` is Apache-2.0; its transitive crates are covered by the existing
   permissive allowlist).
```

Change the first expected result to:

```markdown
- Step 1 passes with `petname` and its transitive dependencies.
```

- [ ] **Step 2: Regenerate third-party notices**

Run from `rust/`:

```bash
cargo about generate about.hbs > THIRD-PARTY-LICENSES.md
```

Expected: notices contain `petname 3.1.0` and no `human_id 0.1.0`.

- [ ] **Step 3: Verify attribution is reproducible**

Run from `rust/`:

```bash
cargo about generate about.hbs > /tmp/climon-notices.md
diff -u THIRD-PARTY-LICENSES.md /tmp/climon-notices.md
rm /tmp/climon-notices.md
```

Expected: `diff` exits successfully with no output.

- [ ] **Step 4: Commit the documentation refresh**

```bash
git add rust/THIRD-PARTY-LICENSES.md docs/manual-tests/phase05-store.md
git commit -m "docs: refresh petname dependency attribution" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: a85e5cd8-7718-4f40-9f5c-f931e2fd1ae3"
```

### Task 3: Verify the Upgrade

**Files:**
- Verify only; no planned modifications.

- [ ] **Step 1: Format the Rust workspace**

Run from `rust/`:

```bash
cargo fmt --check
```

Expected: PASS with no formatting diff.

- [ ] **Step 2: Run the Rust workspace tests**

Run from `rust/`:

```bash
cargo test
```

Expected: all workspace tests PASS.

- [ ] **Step 3: Run Clippy**

Run from `rust/`:

```bash
cargo clippy --all-targets -- -D warnings
```

Expected: PASS with no warnings.

- [ ] **Step 4: Run dependency policy checks**

Run from `rust/`:

```bash
cargo deny check
```

Expected: advisories, bans, licenses, and sources checks PASS; no advisory for `rand`.

- [ ] **Step 5: Inspect the final dependency diff**

Run from the repository root:

```bash
git diff origin/dev...HEAD -- rust/Cargo.toml rust/climon-store/Cargo.toml rust/climon-store/src/session_id.rs rust/Cargo.lock rust/THIRD-PARTY-LICENSES.md docs/manual-tests/phase05-store.md
git status --short
```

Expected: the diff is limited to the dependency replacement, session-ID generator, lockfile, attribution, and matching manual-test text; the worktree is clean.
