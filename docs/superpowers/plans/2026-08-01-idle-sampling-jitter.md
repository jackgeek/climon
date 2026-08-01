# Idle Sampling Jitter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed one-second idle sampling cadence with a fresh pseudo-random 800–1000ms delay before each sample.

**Architecture:** Add a small dependency-free sampling schedule beside the pure idle detector, with deterministic construction from the session ID and a varying linear-congruential sequence. The host idle thread consumes one delay per loop while continuing to measure `attention.idleSeconds` against its existing monotonic clock.

**Tech Stack:** Rust standard library, `climon-session`, Cargo unit and integration tests.

---

### Task 1: Add the idle sample schedule

**Files:**
- Modify: `rust/climon-session/src/idle.rs`

- [ ] **Step 1: Write the failing schedule tests**

Append these tests inside the existing `#[cfg(test)] mod tests` in
`rust/climon-session/src/idle.rs`:

```rust
    #[test]
    fn idle_sample_schedule_stays_within_the_jitter_window() {
        let mut schedule = IdleSampleSchedule::new("session-a");

        for _ in 0..1_000 {
            let delay = schedule.next_delay();
            assert!(delay >= Duration::from_millis(800));
            assert!(delay <= Duration::from_millis(1_000));
        }
    }

    #[test]
    fn idle_sample_schedule_varies_between_samples() {
        let mut schedule = IdleSampleSchedule::new("session-a");
        let first = schedule.next_delay();

        assert!(
            (0..32).any(|_| schedule.next_delay() != first),
            "sampling delay must not remain fixed"
        );
    }
```

Add `use std::time::Duration;` to the test module if it is not already in
scope.

- [ ] **Step 2: Run the tests to verify they fail**

Run from `rust/`:

```bash
cargo test -p climon-session idle_sample_schedule -- --nocapture
```

Expected: compilation fails because `IdleSampleSchedule` does not exist.

- [ ] **Step 3: Implement the dependency-free schedule**

Add this code near the top of `rust/climon-session/src/idle.rs`, after the
existing imports:

```rust
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;

const IDLE_SAMPLE_MIN_MS: u64 = 800;
const IDLE_SAMPLE_JITTER_VALUES: u64 = 201;

/// Produces a fresh 800–1000ms delay for each idle-screen sample.
pub(crate) struct IdleSampleSchedule {
    state: u64,
}

impl IdleSampleSchedule {
    pub(crate) fn new(session_id: &str) -> Self {
        let mut hasher = DefaultHasher::new();
        session_id.hash(&mut hasher);
        Self {
            state: hasher.finish(),
        }
    }

    pub(crate) fn next_delay(&mut self) -> Duration {
        self.state = self
            .state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        let jitter_ms = (self.state >> 32) % IDLE_SAMPLE_JITTER_VALUES;
        Duration::from_millis(IDLE_SAMPLE_MIN_MS + jitter_ms)
    }
}
```

The generator is intentionally non-cryptographic. It avoids an additional
dependency and produces a different cadence per session without introducing a
fallible randomness path into the daemon.

- [ ] **Step 4: Run the focused tests**

Run from `rust/`:

```bash
cargo test -p climon-session idle_sample_schedule -- --nocapture
```

Expected: both `idle_sample_schedule_*` tests pass.

- [ ] **Step 5: Commit the schedule**

```bash
git add rust/climon-session/src/idle.rs
git commit -m "test(session): define idle sampling jitter" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Use jitter in the daemon idle thread

**Files:**
- Modify: `rust/climon-session/src/host.rs:36`
- Modify: `rust/climon-session/src/host.rs:1599-1605`
- Modify: `rust/climon-session/src/lib.rs:16-22`
- Modify: `rust/climon-session/src/fingerprint.rs:1-7`
- Modify: `rust/climon-session/src/idle.rs:21-27`
- Modify: `docs/architecture.md:256-263`

- [ ] **Step 1: Import the schedule into the host**

Change the idle import in `rust/climon-session/src/host.rs` to:

```rust
use crate::idle::{IdleSampleSchedule, ScreenIdleDetector};
```

- [ ] **Step 2: Consume a fresh delay before every sample**

Change the beginning of `spawn_idle_thread` to:

```rust
fn spawn_idle_thread(state: Shared, shutdown: Arc<AtomicBool>) -> JoinHandle<()> {
    thread::spawn(move || {
        let log = climon_logging::logger::child("idle");
        let session_id = state.lock().unwrap().id.clone();
        let mut sample_schedule = IdleSampleSchedule::new(&session_id);
        let mut prev_body: Option<String> = None;
        loop {
            thread::sleep(sample_schedule.next_delay());
            if shutdown.load(Ordering::SeqCst) {
                break;
            }
```

Do not change the monotonic `now_ms`, fingerprint comparison, resize settling,
or transition application below this block.

- [ ] **Step 3: Update frequency documentation**

Update frequency wording without changing behavior descriptions:

- In `rust/climon-session/src/lib.rs`, replace “once a second” with
  “at a jittered 800–1000ms interval”.
- In `rust/climon-session/src/fingerprint.rs`, replace “once a second” with
  “at a jittered 800–1000ms interval”.
- In the `RESIZE_SETTLE_MS` comment in `rust/climon-session/src/idle.rs`,
  replace “the loop ticks once a second” with “the loop samples every
  800–1000ms”.
- In `docs/architecture.md`, replace “once per second” with
  “at a jittered 800–1000ms interval”.

- [ ] **Step 4: Format and run the climon-session tests**

Run from `rust/`:

```bash
cargo fmt --check
cargo test -p climon-session
```

Expected: formatting passes and all `climon-session` unit and integration tests
pass.

- [ ] **Step 5: Run the targeted lint**

Run from `rust/`:

```bash
cargo clippy -p climon-session --all-targets -- -D warnings
```

Expected: clippy exits successfully with no warnings.

- [ ] **Step 6: Commit the wired behavior and documentation**

```bash
git add rust/climon-session/src/host.rs \
  rust/climon-session/src/lib.rs \
  rust/climon-session/src/fingerprint.rs \
  rust/climon-session/src/idle.rs \
  docs/architecture.md
git commit -m "fix(session): jitter idle screen sampling" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Verify the completed change

**Files:**
- Verify only; no expected modifications.

- [ ] **Step 1: Inspect the final diff**

```bash
git diff dev...HEAD -- \
  rust/climon-session/src/host.rs \
  rust/climon-session/src/idle.rs \
  rust/climon-session/src/lib.rs \
  rust/climon-session/src/fingerprint.rs \
  docs/architecture.md
```

Expected: the diff contains only the sampling schedule, host wiring, tests, and
frequency documentation.

- [ ] **Step 2: Run the final targeted validation**

Run from `rust/`:

```bash
cargo fmt --check
cargo test -p climon-session
cargo clippy -p climon-session --all-targets -- -D warnings
```

Expected: every command exits successfully.

- [ ] **Step 3: Confirm the worktree is clean**

```bash
git status --short
```

Expected: no output.
