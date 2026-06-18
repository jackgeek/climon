# Phase 5 — `climon-store` crate (metadata store)

These cases prove that the ported metadata store (`rust/climon-store`) is
byte/format-compatible with the unchanged Bun/TypeScript server, which reads the
same `$CLIMON_HOME/sessions/*.json` files. They cover atomic metadata writes (no
partially-written file ever visible to a reader), the two-layer patch
serialization model (per-process burst coalescing over a cross-process directory
lock with stale-owner recovery), `$CLIMON_HOME` path layout, `human_id` session
ids with collision reroll, the `server.json` server-state file, and the
cross-language golden fixtures under `fixtures/store/`.

Background: Phase 5 ports `src/store.ts`, `src/session-id.ts`, and
`src/server-state.ts` to the new `climon-store` crate, reusing
`climon-proto::meta::{SessionMeta, SessionMetaPatch}` so JSON serialization stays
identical (camelCase, optional-field omission, three-state `color`). The metadata
files are the cross-process coordination boundary between the client, the
per-session daemon, and the server — parity is the whole point. See the
[master plan](../superpowers/specs/2026-06-17-rust-client-rewrite-master-plan.md)
and the [Phase 5 plan](../superpowers/plans/2026-06-19-phase05-climon-store.md).

No configuration matrix applies to this phase: it is single-environment per OS.
Run the cases independently on each platform listed. Several lock-recovery
behaviors are Linux-specific (PID-reuse detection via `/proc/<pid>/stat`); those
steps are called out per case.

---

## MT-P5-01 — `climon-store` builds, tests, and lints on all 3 OSes

- **ID:** MT-P5-01
- **Feature / phase:** Phase 5 — `climon-store` crate
- **Preconditions:** Repo checked out; stable Rust toolchain with `rustfmt` +
  `clippy`.
- **Config-matrix cell:** n/a
- **Platforms:** macOS (arm64), Linux (x64), Windows (x64)

**Steps:**
1. From the repo root: `cd rust`.
2. Build: `cargo build -p climon-store`.
3. Test: `cargo test -p climon-store` (unit + `concurrency` + `store_fixtures`).
4. Lint gates: `cargo fmt --all --check` and
   `cargo clippy --workspace --all-targets -- -D warnings`.

**Expected result:**
- The crate compiles and all `climon-store` tests are green on each platform.
- `fmt --check` reports no diffs; `clippy -D warnings` produces no warnings.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P5-02 — Atomic metadata write (no partial file, rename retry)

- **ID:** MT-P5-02
- **Feature / phase:** Phase 5 — atomic write
- **Preconditions:** `cd rust && cargo build -p climon-store`.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Run the atomic-write tests: `cd rust && cargo test -p climon-store atomic`.
2. Confirm the write path: a temp sibling (`<name>.<pid>.<ms>.<n>.tmp`) is written
   first and then renamed over the target, so a concurrent reader sees either the
   old file or the new file — never a truncated one.
3. Confirm the rename-retry test simulates a transient rename failure and proves
   the write still lands after a retry.

**Expected result:**
- The target file content equals the last full payload after every write.
- No `*.tmp` sibling is left behind on success.
- A transient rename failure is retried and the final content is correct.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P5-03 — Patch serialization: per-process bursts + cross-process lock recovery

- **ID:** MT-P5-03
- **Feature / phase:** Phase 5 — patch lock + per-process queue
- **Preconditions:** `cd rust && cargo build -p climon-store`.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows (PID-reuse step: Linux only)

**Steps:**
1. Per-process burst coalescing: `cargo test -p climon-store patch`. Confirm that
   concurrent patches to **different fields** of the same session all persist and
   that a `from_current` patch sees an earlier patch's write (FIFO-per-id).
2. Cross-process lock + stale recovery:
   `cargo test -p climon-store --test concurrency`. Confirm cases for:
   reclaiming a stale lock with a dead / missing / malformed `owner.json`; a fresh
   live lock and a fresh foreign lock being **preserved** on timeout; a recovery
   lock and reclaim-claim blocking new acquisitions; and an orphaned dead
   reclaim-claim being reclaimed.
3. (Linux only) Confirm the PID-reuse case: a lock owned by a reused PID with a
   different `processStartTime` is treated as stale, while a still-live old PID
   without a recorded start time is preserved.
4. Inspect a live lock on disk while a long patch runs: `sessions/<id>.json.lock/`
   is a **directory** containing `owner.json` (with `pid`, `createdAt`,
   `hostname`, `platform`, `token`).

**Expected result:**
- Same-process patch bursts never drop a field; the result is order-independent
  where the TS implementation is order-independent.
- Stale/dead locks are recovered; fresh/foreign live locks are preserved until
  timeout; the lock directory layout matches what the Bun server/daemon expect.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P5-04 — Metadata interop with the unchanged Bun server

- **ID:** MT-P5-04
- **Feature / phase:** Phase 5 — `SessionMeta` IO parity
- **Preconditions:** `bun install` done; `cd rust && cargo build -p climon-store`.
  A scratch `CLIMON_HOME` (e.g. a fresh empty directory).
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Use a small Rust harness (or a `climon-store` test) to write a `SessionMeta`
   JSON into `$CLIMON_HOME/sessions/<id>.json`.
2. Start the Bun dashboard server pointed at the same `CLIMON_HOME`
   (`CLIMON_HOME=… bun src/index.ts server`).
3. Open the dashboard and confirm the session appears with the correct command,
   status, name, priority, and color.
4. Apply a `userPaused` overlay (write `userPaused: true` over a `running`
   session) and confirm the dashboard shows it as **paused** with the
   running priority reason and cleared attention fields.

**Expected result:**
- The Bun server parses the Rust-written metadata without error and renders all
  fields correctly, including omitted-optional and three-state `color`.
- The `userPaused` overlay renders identically to the TS implementation.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P5-05 — Session id format + collision reroll

- **ID:** MT-P5-05
- **Feature / phase:** Phase 5 — `session_id`
- **Preconditions:** `cd rust && cargo build -p climon-store`.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Run the session-id tests: `cargo test -p climon-store session_id`.
2. Confirm a generated id matches `^[a-z]+(-[a-z]+){2}$` (lowercase
   adjective-noun-verb, hyphen-separated, filesystem-safe).
3. Confirm that when a candidate id already has a metadata file the generator
   re-rolls, and that exhausting `MAX_ATTEMPTS` (50) collisions returns an error
   (no random-suffix fallback).

**Expected result:**
- Generated ids are lowercase-hyphenated and filesystem-safe.
- Collisions re-roll; 50 consecutive collisions error out by design.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P5-06 — `server.json` server-state read/write parity

- **ID:** MT-P5-06
- **Feature / phase:** Phase 5 — `server_state`
- **Preconditions:** `bun install` done; `cd rust && cargo build -p climon-store`.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Run the server-state tests: `cargo test -p climon-store server_state`.
2. Write a `server.json` from the Rust port (`pid`, `port`, optional `ingest`,
   `startedAt`) and confirm the Bun `parseServerState` reads back the same object.
3. Confirm invalid inputs (non-integer / non-positive `pid`/`port`, malformed
   JSON, `ingest: 0`) are rejected exactly as the TS implementation rejects them.

**Expected result:**
- Round-trip Rust→Bun and Bun→Rust produce identical state objects.
- Optional fields are omitted when absent; invalid pid/port yields `None`/
  `undefined` on both sides.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P5-07 — Cross-language golden fixtures (merge + server-state)

- **ID:** MT-P5-07
- **Feature / phase:** Phase 5 — `fixtures/store/`
- **Preconditions:** `bun install` done; `cd rust` builds.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Assert the Rust side: `cd rust && cargo test -p climon-store --test store_fixtures`.
2. Assert the Bun side against the **same** corpus:
   `bun test tests/store-fixtures.test.ts` (from the repo root).
3. Inspect `fixtures/store/merge/{base,patch,expected}.json`: applying the patch
   to the base (JS spread / Rust `merge_patch`) must equal `expected.json`,
   including the explicit `color: null` overriding the base `cyan`.
4. Inspect `fixtures/store/server-state/{minimal,full}.json`.

**Expected result:**
- Both the Rust integration test and `tests/store-fixtures.test.ts` pass against
  the single shared corpus.
- The merge result and server-state parse are identical across the two languages.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P5-08 — License gate + attribution freshness (`human_id` added)

- **ID:** MT-P5-08
- **Feature / phase:** Phase 5 — license tooling
- **Preconditions:** `cargo-deny` and `cargo-about` installed. `cd rust`.
- **Config-matrix cell:** n/a
- **Platforms:** Linux (CI parity); optionally macOS/Windows

**Steps:**
1. Baseline: `cargo deny check` — advisories/bans/licenses/sources all ok
   (the new `human_id` dependency is `Unlicense OR MIT`; its transitive crates are
   covered by the existing permissive allowlist).
2. Attribution freshness: regenerate and diff against the committed file:
   `cargo about generate about.hbs > NOTICES.tmp.md && diff -u THIRD-PARTY-LICENSES.md NOTICES.tmp.md && rm NOTICES.tmp.md`
   — expect **no diff**.
3. Negative test (optional): temporarily add a copyleft (e.g. GPL) crate, run
   `cargo deny check`, confirm it fails, then revert.

**Expected result:**
- Step 1 passes with `human_id` and its transitive dependencies.
- Step 2 produces no diff (the committed `THIRD-PARTY-LICENSES.md` is current).
- Step 3 fails the gate on a non-allowlisted license, then is green after revert.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
