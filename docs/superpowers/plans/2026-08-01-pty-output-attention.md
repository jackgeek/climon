# PTY Output Attention Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace sampled screen-fingerprint attention detection with a fixed one-second poll of elapsed time since the most recent PTY output.

**Architecture:** `OutputIdleDetector` owns the output-idle state machine, while the PTY reader records every output chunk synchronously and the timer thread only polls elapsed monotonic time. Browser acknowledgement safety uses an output-generation counter instead of a screen fingerprint; the VT grid remains solely for repaint and notification snippets.

**Tech Stack:** Rust, Bun/TypeScript config registries and generators, Cargo tests/clippy, Bun config parity tests.

---

### Task 1: Replace the Rust attention state machine

**Files:**
- Modify: `rust/climon-session/src/idle.rs`
- Modify: `rust/climon-session/src/attention.rs`
- Modify: `rust/climon-session/src/host.rs`
- Modify: `rust/climon-session/src/lib.rs`
- Modify: `rust/climon-session/src/fingerprint.rs`
- Modify: `rust/climon-session/tests/session_integration.rs`

- [ ] **Step 1: Replace the detector tests with output-idle behavior tests**

In `rust/climon-session/src/idle.rs`, replace the fingerprint-, resize-, and
jitter-specific tests with tests covering this public behavior:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn attention(reason: &str) -> Option<IdleTransition> {
        Some(IdleTransition {
            needs_attention: true,
            reason: Some(reason.to_string()),
        })
    }

    fn running() -> Option<IdleTransition> {
        Some(IdleTransition {
            needs_attention: false,
            reason: None,
        })
    }

    #[test]
    fn flags_after_the_output_idle_window() {
        let mut detector = OutputIdleDetector::new(10);
        assert_eq!(detector.poll(9_999), None);
        assert_eq!(
            detector.poll(10_000),
            attention("No terminal output for 10s")
        );
    }

    #[test]
    fn output_resets_the_idle_clock() {
        let mut detector = OutputIdleDetector::new(10);
        assert_eq!(detector.record_output(9_000), None);
        assert_eq!(detector.poll(18_999), None);
        assert_eq!(
            detector.poll(19_000),
            attention("No terminal output for 10s")
        );
    }

    #[test]
    fn output_clears_flagged_attention() {
        let mut detector = OutputIdleDetector::new(10);
        detector.poll(10_000);
        assert_eq!(detector.record_output(10_500), running());
        assert_eq!(detector.poll(20_499), None);
        assert_eq!(
            detector.poll(20_500),
            attention("No terminal output for 10s")
        );
    }

    #[test]
    fn acknowledgement_suppresses_reflagging_until_output() {
        let mut detector = OutputIdleDetector::new(10);
        detector.poll(10_000);
        detector.acknowledge();
        assert_eq!(detector.poll(100_000), None);
        assert_eq!(detector.record_output(101_000), running());
        assert_eq!(detector.poll(110_999), None);
        assert_eq!(
            detector.poll(111_000),
            attention("No terminal output for 10s")
        );
    }

    #[test]
    fn disabled_detector_never_transitions() {
        let mut detector = OutputIdleDetector::new(0);
        assert_eq!(detector.poll(100_000), None);
        assert_eq!(detector.record_output(100_000), None);
        detector.acknowledge();
        assert_eq!(detector.poll(200_000), None);
    }
}
```

- [ ] **Step 2: Replace acknowledgement tests with output-generation tests**

In `rust/climon-session/src/attention.rs`, replace the fingerprint helpers and
their tests with:

```rust
/// Accepts a browser acknowledgement only for the current attention token and
/// only when no PTY output has arrived since attention was flagged.
pub fn should_apply_user_attention_acknowledgement(
    last_attention_state: Option<bool>,
    current_attention_matched_at: Option<&str>,
    acknowledged_attention_matched_at: Option<&str>,
    attention_output_generation: Option<u64>,
    current_output_generation: u64,
) -> bool {
    last_attention_state == Some(true)
        && current_attention_matched_at.is_some()
        && acknowledged_attention_matched_at == current_attention_matched_at
        && attention_output_generation == Some(current_output_generation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_current_token_when_no_output_has_arrived() {
        assert!(should_apply_user_attention_acknowledgement(
            Some(true),
            Some("token"),
            Some("token"),
            Some(7),
            7,
        ));
    }

    #[test]
    fn rejects_stale_token() {
        assert!(!should_apply_user_attention_acknowledgement(
            Some(true),
            Some("current"),
            Some("stale"),
            Some(7),
            7,
        ));
    }

    #[test]
    fn rejects_acknowledgement_after_new_output() {
        assert!(!should_apply_user_attention_acknowledgement(
            Some(true),
            Some("token"),
            Some("token"),
            Some(7),
            8,
        ));
    }

    #[test]
    fn rejects_when_attention_is_not_outstanding() {
        assert!(!should_apply_user_attention_acknowledgement(
            Some(false),
            Some("token"),
            Some("token"),
            Some(7),
            7,
        ));
    }
}
```

- [ ] **Step 3: Run the focused tests and confirm RED**

Run from `rust/`:

```bash
cargo test -p climon-session idle::tests -- --nocapture
cargo test -p climon-session attention::tests -- --nocapture
```

Expected: compilation fails because `OutputIdleDetector`, `poll`,
`record_output`, and the new acknowledgement signature do not exist.

- [ ] **Step 4: Implement `OutputIdleDetector`**

Replace the implementation in `rust/climon-session/src/idle.rs` with:

```rust
//! PTY-output idle detector.
//!
//! Pure (no timers, no I/O): callers record output with a monotonic timestamp
//! and poll with the current timestamp. A session needs attention after no PTY
//! output has arrived for `idle_seconds`.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleTransition {
    pub needs_attention: bool,
    pub reason: Option<String>,
}

pub struct OutputIdleDetector {
    idle_ms: i64,
    last_output_at: i64,
    flagged: bool,
    acknowledged: bool,
}

impl OutputIdleDetector {
    pub fn new(idle_seconds: i64) -> Self {
        Self {
            idle_ms: idle_seconds * 1000,
            last_output_at: 0,
            flagged: false,
            acknowledged: false,
        }
    }

    pub fn is_flagged(&self) -> bool {
        self.flagged
    }

    pub fn is_acknowledged(&self) -> bool {
        self.acknowledged
    }

    pub fn last_output_at(&self) -> i64 {
        self.last_output_at
    }

    pub fn poll(&mut self, now: i64) -> Option<IdleTransition> {
        if self.idle_ms <= 0 || self.flagged || self.acknowledged {
            return None;
        }
        if now - self.last_output_at < self.idle_ms {
            return None;
        }
        self.flagged = true;
        Some(IdleTransition {
            needs_attention: true,
            reason: Some(format!(
                "No terminal output for {}s",
                self.idle_ms / 1000
            )),
        })
    }

    pub fn record_output(&mut self, now: i64) -> Option<IdleTransition> {
        if self.idle_ms <= 0 {
            return None;
        }
        self.last_output_at = now;
        let was_active = self.flagged || self.acknowledged;
        self.flagged = false;
        self.acknowledged = false;
        was_active.then_some(IdleTransition {
            needs_attention: false,
            reason: None,
        })
    }

    pub fn acknowledge(&mut self) {
        if self.idle_ms <= 0 {
            return;
        }
        self.flagged = false;
        self.acknowledged = true;
    }
}
```

Update `rust/climon-session/src/lib.rs` to export:

```rust
pub use idle::{IdleTransition, OutputIdleDetector};
```

- [ ] **Step 5: Wire PTY output and generation state through the host**

In `rust/climon-session/src/host.rs`:

1. Import `OutputIdleDetector` instead of `IdleSampleSchedule` and
   `ScreenIdleDetector`.
2. Replace `current_attention_fingerprint` with:

```rust
current_attention_output_generation: Option<u64>,
output_generation: u64,
```

3. Replace the detector field with:

```rust
idle_detector: OutputIdleDetector,
```

4. Remove `idle_detector.absorb_resize`, settle-window logging, and all
   fingerprint-body idle logging from resize and timer paths.
5. Change `apply_attention` to take only `payload` and `source`. Validate browser
   acknowledgement with `current_attention_output_generation` and
   `output_generation`. On user acknowledgement call:

```rust
self.idle_detector.acknowledge();
```

6. When flagging attention, store:

```rust
self.current_attention_output_generation = Some(self.output_generation);
```

7. When clearing attention, clear
   `current_attention_output_generation`.
8. Initialize the new fields to `None` and `0`, and construct
   `OutputIdleDetector::new(idle_seconds)`.
9. In the PTY reader, immediately after receiving each non-empty `data` chunk,
   increment the generation and record output:

```rust
s.output_generation = s.output_generation.wrapping_add(1);
let now_ms = s.started_at.elapsed().as_millis() as i64;
let output_transition = s.idle_detector.record_output(now_ms);
```

After updating the grid, apply `output_transition` through
`apply_attention(..., AttentionSource::Detector)` before broadcasting the
output frame.
10. Restore the timer loop to:

```rust
thread::sleep(Duration::from_millis(1000));
```

and replace fingerprint sampling with:

```rust
let transition = s.idle_detector.poll(now_ms);
```

Log `lastOutputAt`, `wasFlagged`, `wasAcknowledged`, and the transition.

- [ ] **Step 6: Update Rust module documentation and integration expectations**

- Rewrite `rust/climon-session/src/fingerprint.rs` module documentation to say
  the grid supports repainting and smart-notification snippets, not idle
  detection.
- Update `rust/climon-session/src/lib.rs` idle documentation to describe
  PTY-output inactivity.
- In `rust/climon-session/tests/session_integration.rs`, replace expected
  `"Screen idle for 1s"` with `"No terminal output for 1s"` and update comments
  from static-screen/fingerprint detection to output inactivity.

- [ ] **Step 7: Run Rust validation**

Run from `rust/`:

```bash
cargo fmt
cargo test -p climon-session
cargo clippy -p climon-session --all-targets -- -D warnings
```

Expected: all commands pass.

- [ ] **Step 8: Commit the Rust behavior**

```bash
git add rust/climon-session/src/attention.rs \
  rust/climon-session/src/fingerprint.rs \
  rust/climon-session/src/host.rs \
  rust/climon-session/src/idle.rs \
  rust/climon-session/src/lib.rs \
  rust/climon-session/tests/session_integration.rs
git commit -m "fix(session): detect attention from PTY inactivity" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Update configuration, generated docs, and manual coverage

**Files:**
- Modify: `src/config-settings.ts`
- Modify: `src/types.ts`
- Modify: `rust/climon-config/src/config_settings.rs`
- Modify: generated files under `fixtures/config/`
- Modify: generated configuration sections in `docs/setup.md` and `docs/usage.md`
- Modify: `docs/architecture.md`
- Modify: `docs/features.md`
- Modify: `docs/manual-tests/phase07-session.md`

- [ ] **Step 1: Change the config purpose in both registries**

Use this purpose text in `src/config-settings.ts` and
`rust/climon-config/src/config_settings.rs`:

```text
Number of seconds with no terminal output before the session is flagged as needing attention. Set to 0 or negative to disable output-idle detection.
```

Update the `attention.idleSeconds` comment in `src/types.ts` to the same
semantics.

- [ ] **Step 2: Regenerate shared fixtures and config documentation**

Run from the repository root:

```bash
bun scripts/gen-config-fixtures.ts
bun run docs:config
```

Expected: the generated fixtures and config documentation use the new purpose
text while defaults and types remain unchanged.

- [ ] **Step 3: Update architecture, usage, catalogue, and manual tests**

Make these behavioral statements explicit:

- `docs/architecture.md`: the reader records every PTY output chunk; a fixed
  one-second timer flags after the configured output-silent period; output
  generation protects acknowledgements.
- `docs/usage.md`: attention means no terminal output for the configured period;
  any subsequent output returns the session to running.
- `docs/features.md` `cli-09`: rename the description from static-screen
  detection to PTY-output inactivity without changing the stable ID.
- `docs/manual-tests/phase07-session.md`:
  - MT-P7-05 expects output silence, then acknowledgement, then new output.
  - MT-P7-09 expects acknowledgement to persist until PTY output.
  - MT-P7-10 expects a resize-triggered redraw to count as output, transition to
    running, and start a fresh idle window.

- [ ] **Step 4: Run config and documentation validation**

Run:

```bash
bun test tests/config-fixtures.test.ts
cd rust && cargo test -p climon-config
```

Expected: both suites pass.

- [ ] **Step 5: Commit configuration and documentation**

```bash
git add src/config-settings.ts src/types.ts \
  rust/climon-config/src/config_settings.rs \
  fixtures/config docs/setup.md docs/usage.md docs/architecture.md \
  docs/features.md docs/manual-tests/phase07-session.md
git commit -m "docs: describe PTY output attention detection" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Remove the abandoned jitter artifacts and verify

**Files:**
- Delete: `docs/superpowers/specs/2026-08-01-idle-sampling-jitter-design.md`
- Delete: `docs/superpowers/plans/2026-08-01-idle-sampling-jitter.md`
- Verify all changed files.

- [ ] **Step 1: Remove the abandoned design and plan**

Delete only:

```text
docs/superpowers/specs/2026-08-01-idle-sampling-jitter-design.md
docs/superpowers/plans/2026-08-01-idle-sampling-jitter.md
```

Keep the approved PTY-output design and this implementation plan.

- [ ] **Step 2: Search for stale detector terminology**

Run:

```bash
rg -n "IdleSampleSchedule|ScreenIdleDetector|static-screen detection|Screen idle for|jittered 800|fingerprint.*attention|attention.*fingerprint" rust/climon-session src docs README.md
```

Expected: no stale runtime/config/documentation claims remain. References in
historical handoff documents may remain when clearly historical.

- [ ] **Step 3: Run final targeted validation**

Run:

```bash
cd rust
cargo fmt --check
cargo test -p climon-session -p climon-config
cargo clippy -p climon-session --all-targets -- -D warnings
cd ..
bun test tests/config-fixtures.test.ts
git status --short
```

Expected: formatting, tests, and clippy pass; status shows only the two intended
tracked deletions before commit.

- [ ] **Step 4: Commit cleanup**

```bash
git add -u docs/superpowers/specs/2026-08-01-idle-sampling-jitter-design.md \
  docs/superpowers/plans/2026-08-01-idle-sampling-jitter.md
git commit -m "docs: remove abandoned sampling jitter design" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 5: Inspect the complete branch diff**

```bash
git diff origin/dev...HEAD --stat
git diff origin/dev...HEAD -- \
  rust/climon-session src/config-settings.ts src/types.ts \
  rust/climon-config/src/config_settings.rs fixtures/config \
  docs/architecture.md docs/usage.md docs/setup.md docs/features.md \
  docs/manual-tests/phase07-session.md
```

Expected: the net branch replaces jitter/fingerprint-driven attention with PTY
output inactivity and includes the previously approved download-stat fix.
