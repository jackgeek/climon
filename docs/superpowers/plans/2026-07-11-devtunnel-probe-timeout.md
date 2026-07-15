# Devtunnel launch-probe timeout + messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the synchronous launch-time Dev Tunnels probe with a 5-second timeout so a stalled `devtunnel` never hangs session start or fails silently; on timeout, warn the user and still spawn the uplink best-effort.

**Architecture:** Add a `timed_out` state to `DevtunnelProbe`. Wrap the probe's `detect() + show_user()` future in `tokio::time::timeout`. Handle `timed_out` in the pure `plan_uplink_start` decision function (best-effort spawn + warning), keeping the existing missing-CLI and logged-out warnings unchanged.

**Tech Stack:** Rust (`climon-cli` crate), tokio, existing `DevtunnelGateway` in `climon-remote`.

---

## File structure

- `rust/climon-cli/src/launcher.rs` — the only source file changed:
  - `DevtunnelProbe` struct gains `timed_out: bool`.
  - `probe_devtunnel_sync()` wraps its async body in `tokio::time::timeout` and returns the timeout state on elapse.
  - `plan_uplink_start()` gains a `timed_out` branch.
  - Unit tests (same file, `#[cfg(test)] mod tests`) updated + new tests.
- `docs/manual-tests/devtunnel-resilience.md` — new manual case `DTRS-11`.
- `docs/manual-tests/README.md` — no new file link needed (case added to existing `devtunnel-resilience.md` already indexed at line 56); no change required.
- `docs/architecture.md` — one-line note on the probe timeout (Task 5).

Because `probe_devtunnel_sync()` constructs `DevtunnelGateway::new()` inline (not injectable), the I/O timeout wrapper is verified by the manual test `DTRS-11`, not a unit test. The pure decision logic in `plan_uplink_start` is fully unit-tested.

---

## Task 1: Add `timed_out` to `DevtunnelProbe` and fix all existing constructions

This is a compile-driven refactor: adding the field breaks every `DevtunnelProbe { .. }` literal, so we add the field and update all constructions/tests in one commit to keep the tree compiling.

**Files:**
- Modify: `rust/climon-cli/src/launcher.rs`

- [ ] **Step 1: Add the `timed_out` field to the struct**

In `rust/climon-cli/src/launcher.rs`, change the struct (currently lines 264-268):

```rust
/// Launch-time Dev Tunnels probe result: whether the CLI is runnable and, if so,
/// whether the user is signed in, plus whether the probe timed out before it
/// could answer. Lets `plan_uplink_start` tell "CLI missing" apart from "CLI
/// present but logged out" apart from "devtunnel stalled / didn't respond".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevtunnelProbe {
    pub available: bool,
    pub authenticated: bool,
    pub timed_out: bool,
}
```

- [ ] **Step 2: Update the three production `DevtunnelProbe` constructions in `probe_devtunnel_sync` and the non-probe branch**

`probe_devtunnel_sync()` (lines 334-362) has three literals; add `timed_out: false` to each (the runtime-build-failure early return at ~341, the not-available return at ~351, and the final success return at ~357). The full function body after this step:

```rust
fn probe_devtunnel_sync() -> DevtunnelProbe {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(_) => {
            return DevtunnelProbe {
                available: false,
                authenticated: false,
                timed_out: false,
            }
        }
    };
    runtime.block_on(async {
        let gateway = DevtunnelGateway::new();
        let detected = gateway.detect().await;
        if !detected.available {
            return DevtunnelProbe {
                available: false,
                authenticated: false,
                timed_out: false,
            };
        }
        let user = gateway.show_user().await;
        DevtunnelProbe {
            available: true,
            authenticated: user.authenticated,
            timed_out: false,
        }
    })
}
```

(The timeout wrapper is added in Task 3; this step only keeps it compiling.)

- [ ] **Step 3: Update the non-probe branch construction in `ensure_uplink`**

In `ensure_uplink()` (the `else` branch at ~421-424) add `timed_out: false`:

```rust
        let probe = if needs_tunnel {
            probe_devtunnel_sync()
        } else {
            DevtunnelProbe {
                available: false,
                authenticated: false,
                timed_out: false,
            }
        };
```

- [ ] **Step 4: Update all `DevtunnelProbe` literals in the test module**

Add `timed_out: false,` to each of the six existing test literals in `#[cfg(test)] mod tests` (at approximately lines 805, 828, 851, 874, 897, 920). For example, `plan_uplink_warns_when_devtunnel_unavailable` becomes:

```rust
            &DevtunnelProbe {
                available: false,
                authenticated: false,
                timed_out: false,
            },
```

Apply the same `timed_out: false,` addition to the literals in:
- `plan_uplink_warns_when_devtunnel_unavailable`
- `plan_uplink_warns_when_devtunnel_logged_out`
- `plan_uplink_spawns_with_tunnel_and_devtunnel`
- `plan_uplink_spawns_for_direct_host_without_devtunnel`
- `plan_uplink_noop_when_config_incomplete`
- `plan_uplink_noop_when_only_enabled`

- [ ] **Step 5: Verify it compiles and existing tests pass**

Run (from `rust/`):

```bash
cargo test -p climon-cli launcher::tests::plan_uplink 2>&1 | tail -20
```

Expected: PASS (all six `plan_uplink_*` tests pass; no compile errors).

- [ ] **Step 6: Commit**

```bash
git add rust/climon-cli/src/launcher.rs
git commit -m "refactor(launcher): add timed_out state to DevtunnelProbe"
```

---

## Task 2: `plan_uplink_start` handles the timeout (best-effort spawn + warning)

TDD: write the failing tests first, then add the branch.

**Files:**
- Modify: `rust/climon-cli/src/launcher.rs` (`plan_uplink_start` at ~271-312; tests in `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing tests**

Add these two tests to the `#[cfg(test)] mod tests` block in `rust/climon-cli/src/launcher.rs` (next to the other `plan_uplink_*` tests):

```rust
    #[test]
    fn plan_uplink_spawns_best_effort_on_probe_timeout() {
        let plan = plan_uplink_start(
            &UplinkStartConfig {
                enabled: true,
                host: None,
                tunnel_id: Some("spiffy-chair-c2lj709.eun1".to_string()),
                port: None,
            },
            &DevtunnelProbe {
                available: false,
                authenticated: false,
                timed_out: true,
            },
        );
        assert!(plan.should_spawn, "timeout should still spawn best-effort");
        let warning = plan.warning.expect("timeout must warn the user");
        assert!(
            warning.contains("didn't respond within 5s"),
            "warning should explain the timeout, got: {warning}"
        );
        assert!(
            warning.contains("climon remotes"),
            "warning should point at `climon remotes`, got: {warning}"
        );
    }

    #[test]
    fn plan_uplink_ignores_timeout_for_direct_host() {
        // A direct host+port never needs devtunnel, so a timeout is irrelevant:
        // spawn directly with no warning.
        let plan = plan_uplink_start(
            &UplinkStartConfig {
                enabled: true,
                host: Some("172.30.192.1".to_string()),
                tunnel_id: None,
                port: Some(3132),
            },
            &DevtunnelProbe {
                available: false,
                authenticated: false,
                timed_out: true,
            },
        );
        assert_eq!(
            plan,
            UplinkStartPlan {
                should_spawn: true,
                warning: None
            }
        );
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `rust/`):

```bash
cargo test -p climon-cli launcher::tests::plan_uplink_spawns_best_effort_on_probe_timeout launcher::tests::plan_uplink_ignores_timeout_for_direct_host 2>&1 | tail -20
```

Expected: `plan_uplink_spawns_best_effort_on_probe_timeout` FAILS (current code returns `should_spawn: false` for `available: false` because it hits the not-available branch). `plan_uplink_ignores_timeout_for_direct_host` PASSES (direct host path already returns early before the probe is consulted) — that is fine, it guards against regressions.

- [ ] **Step 3: Add the `timed_out` branch to `plan_uplink_start`**

In `plan_uplink_start()`, insert the timeout branch **after** the `tunnel_id.is_none()` check and **before** the `!probe.available` check. The function becomes:

```rust
pub fn plan_uplink_start(config: &UplinkStartConfig, probe: &DevtunnelProbe) -> UplinkStartPlan {
    if !config.enabled {
        return UplinkStartPlan {
            should_spawn: false,
            warning: None,
        };
    }
    if config.host.is_some() && config.port.is_some() {
        return UplinkStartPlan {
            should_spawn: true,
            warning: None,
        };
    }
    if config.tunnel_id.is_none() {
        return UplinkStartPlan {
            should_spawn: false,
            warning: None,
        };
    }
    if probe.timed_out {
        // Dev Tunnels stalled instead of answering. We can't tell healthy from
        // broken, so spawn best-effort (the detached uplink retries discovery
        // with capped backoff and reports state via `climon remotes`) and warn
        // the user rather than hang or fail silently.
        return UplinkStartPlan {
            should_spawn: true,
            warning: Some(
                "climon: Dev Tunnels didn't respond within 5s; starting remote monitoring anyway. If sessions don't appear on the remote dashboard, check `climon remotes` or run `devtunnel user login`.\n"
                    .to_string(),
            ),
        };
    }
    if !probe.available {
        return UplinkStartPlan {
            should_spawn: false,
            warning: Some(
                "climon: remote monitoring is configured, but the devtunnel CLI is not installed or not runnable on this machine. Install devtunnel for sessions to appear on the remote dashboard.\n"
                    .to_string(),
            ),
        };
    }
    if !probe.authenticated {
        return UplinkStartPlan {
            should_spawn: false,
            warning: Some(
                "climon: remote monitoring is configured, but Dev Tunnels is not signed in. Run `devtunnel user login`, then retry the session.\n"
                    .to_string(),
            ),
        };
    }
    UplinkStartPlan {
        should_spawn: true,
        warning: None,
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `rust/`):

```bash
cargo test -p climon-cli launcher::tests::plan_uplink 2>&1 | tail -20
```

Expected: PASS — all `plan_uplink_*` tests pass, including the two new ones and the six pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add rust/climon-cli/src/launcher.rs
git commit -m "feat(launcher): warn and spawn best-effort on devtunnel probe timeout"
```

---

## Task 3: Bound `probe_devtunnel_sync` with a 5s timeout

**Files:**
- Modify: `rust/climon-cli/src/launcher.rs` (`probe_devtunnel_sync` at ~334-362; add a `use` for `Duration`)

- [ ] **Step 1: Add the `Duration` import and timeout constant**

At the top of `rust/climon-cli/src/launcher.rs`, in the `use std::...` block (currently `use std::collections::HashMap;` / `use std::path::Path;` at lines 7-8), add:

```rust
use std::time::Duration;
```

Then, immediately above the `probe_devtunnel_sync` function, add the constant:

```rust
/// Total wall-clock budget for the launch-time Dev Tunnels probe
/// (`detect()` + `show_user()`). Long enough for a healthy network round-trip,
/// short enough that a stalled `devtunnel` never feels like a hang. On elapse
/// the probe reports `timed_out` and the launcher spawns the uplink best-effort.
const DEVTUNNEL_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
```

- [ ] **Step 2: Wrap the probe body in `tokio::time::timeout`**

Replace the `runtime.block_on(async { ... })` body of `probe_devtunnel_sync` so the whole probe is bounded. The function becomes:

```rust
fn probe_devtunnel_sync() -> DevtunnelProbe {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(_) => {
            return DevtunnelProbe {
                available: false,
                authenticated: false,
                timed_out: false,
            }
        }
    };
    runtime.block_on(async {
        let probe = async {
            let gateway = DevtunnelGateway::new();
            let detected = gateway.detect().await;
            if !detected.available {
                return DevtunnelProbe {
                    available: false,
                    authenticated: false,
                    timed_out: false,
                };
            }
            let user = gateway.show_user().await;
            DevtunnelProbe {
                available: true,
                authenticated: user.authenticated,
                timed_out: false,
            }
        };
        match tokio::time::timeout(DEVTUNNEL_PROBE_TIMEOUT, probe).await {
            Ok(result) => result,
            Err(_) => DevtunnelProbe {
                available: false,
                authenticated: false,
                timed_out: true,
            },
        }
    })
}
```

- [ ] **Step 3: Verify it compiles and the full launcher test set passes**

Run (from `rust/`):

```bash
cargo test -p climon-cli launcher 2>&1 | tail -20
```

Expected: PASS — no compile errors, all launcher tests green.

- [ ] **Step 4: Clippy check the crate**

Run (from `rust/`):

```bash
cargo clippy -p climon-cli --all-targets 2>&1 | tail -20
```

Expected: no new warnings/errors from the changed code.

- [ ] **Step 5: Commit**

```bash
git add rust/climon-cli/src/launcher.rs
git commit -m "fix(launcher): bound devtunnel launch probe with a 5s timeout"
```

---

## Task 4: Manual test case (DTRS-11)

**Files:**
- Modify: `docs/manual-tests/devtunnel-resilience.md`

- [ ] **Step 1: Append the new case**

Append the following case to the end of `docs/manual-tests/devtunnel-resilience.md` (after the `DTRS-10` block, keeping the trailing `---` separator style):

```markdown

## DTRS-11 — Stalled devtunnel at launch: 5s timeout, warning, best-effort spawn

- **ID:** DTRS-11
- **Feature / phase:** Dev-tunnel resilience — bounded launch probe with
  best-effort spawn (`rust/climon-cli/src/launcher.rs` `probe_devtunnel_sync`,
  `plan_uplink_start`).
- **Preconditions:** `remote.enabled = true` and `remote.tunnelId` set (no
  direct `remote.host`), so launching a session runs the synchronous devtunnel
  probe. Ability to put a **stub `devtunnel` that sleeps > 5s** first on `PATH`
  (e.g. a script that runs `sleep 30` for any args, or on Windows a `.cmd` that
  `timeout /t 30`). This simulates a stalled Dev Tunnels network call.
- **Config-matrix cell:** Remote ingest/uplink
- **Platforms:** macOS, Linux, Windows (devbox/uplink side)

**Steps:**
1. Put the sleeping stub `devtunnel` first on `PATH` so `devtunnel --version`
   hangs for ~30s.
2. Launch a session, e.g. `climon shell` (or `bun run dev shell` from source).
3. Time how long until the session terminal appears, and read stderr.

**Expected:** The session starts within ~5 seconds (not blocked for the full
stub sleep). Before/at launch, stderr prints the warning `climon: Dev Tunnels
didn't respond within 5s; starting remote monitoring anyway. If sessions don't
appear on the remote dashboard, check `climon remotes` or run `devtunnel user
login`.` The uplink is still spawned (best-effort). Removing the stub and using
a real, healthy `devtunnel` prints no such warning and starts normally.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |
```

- [ ] **Step 2: Commit**

```bash
git add docs/manual-tests/devtunnel-resilience.md
git commit -m "docs(manual-tests): DTRS-11 devtunnel launch-probe timeout"
```

---

## Task 5: Architecture doc note

**Files:**
- Modify: `docs/architecture.md`

- [ ] **Step 1: Find the launch/uplink probe description**

Run (from repo root):

```bash
grep -n "probe_devtunnel_sync\|ensure_uplink\|launch-time\|Dev Tunnels probe\|devtunnel" docs/architecture.md | head
```

Expected: locate the paragraph describing the launcher's uplink/devtunnel behaviour (e.g. near the remote roles section around line 427). If no probe-specific sentence exists, add the note to the sentence describing `ensure_uplink`/uplink spawn at launch.

- [ ] **Step 2: Add the timeout note**

Insert a sentence where the launch-time uplink/probe behaviour is described, worded to match the surrounding prose, e.g.:

```markdown
The launch-time Dev Tunnels probe (CLI availability + sign-in) is bounded by a
5-second timeout: if `devtunnel` stalls, the launcher warns the user and spawns
the uplink best-effort rather than blocking session start.
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md
git commit -m "docs(architecture): note the 5s devtunnel launch-probe timeout"
```

---

## Task 6: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full `climon-cli` test suite**

Run (from `rust/`):

```bash
cargo test -p climon-cli 2>&1 | tail -25
```

Expected: PASS — all tests green.

- [ ] **Step 2: Clippy + fmt gates**

Run (from `rust/`):

```bash
cargo clippy -p climon-cli --all-targets 2>&1 | tail -20 && cargo fmt --check 2>&1 | tail -20
```

Expected: clippy clean for changed code; `cargo fmt --check` reports no diff (run `cargo fmt` and re-commit if it does).

- [ ] **Step 3: Confirm the branch is ready**

Run (from repo root):

```bash
git log --oneline origin/dev..HEAD | head
git status --short
```

Expected: the new commits are present, working tree clean. The branch targets `dev` for its PR (squash merge) per repo convention.
```
