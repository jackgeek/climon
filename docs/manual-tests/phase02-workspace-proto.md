# Phase 2 — Cargo workspace + `climon-proto` crate

These cases prove that the Rust workspace builds and tests on every supported OS,
that the ported protocol crate (`climon-proto`) stays byte-for-byte compatible
with the Bun/TypeScript implementation via a shared golden corpus, that session
metadata round-trips with correct three-state `color` semantics, and that the
license tooling (`cargo-deny` + `cargo-about`) gates dependencies and keeps the
attribution file current.

Background: Phase 2 converts `rust/` into a Cargo workspace (`climon-rs` PoC bin +
new `climon-proto` lib) and ports the frame codec, `SessionMeta`/`SessionMetaPatch`
types, priority sorting, and color/priority parsers from TypeScript. Wire
compatibility with the unchanged Bun server is the core invariant, enforced by the
cross-language fixtures under `fixtures/proto/`. See
[`docs/architecture.md`](../architecture.md) and the
[master plan](../superpowers/specs/2026-06-17-rust-client-rewrite-master-plan.md).

No configuration matrix applies to this phase: it is single-environment per OS.
Run the cases independently on each platform listed.

---

## MT-P2-01 — Workspace builds and tests on all 3 OSes

- **ID:** MT-P2-01
- **Feature / phase:** Phase 2 — Cargo workspace bootstrap
- **Preconditions:** Repo checked out; a stable Rust toolchain installed
  (`rustup show` lists a `stable` default with `rustfmt` + `clippy` components).
- **Config-matrix cell:** n/a
- **Platforms:** macOS (arm64), Linux (x64), Windows (x64)

**Steps:**
1. From the repo root: `cd rust`.
2. Build the whole workspace: `cargo build --workspace`.
3. Run the whole test suite: `cargo test --workspace`.
4. Run the lint gates the same way CI does:
   `cargo fmt --all --check` and
   `cargo clippy --workspace --all-targets -- -D warnings`.

**Expected result:**
- `cargo build --workspace` compiles both `climon-rs` and `climon-proto` with no
  errors.
- `cargo test --workspace` is green on each platform (the `climon-proto` unit
  tests, the `fixtures` integration test, and the existing PoC tests all pass).
- `fmt --check` reports no diffs and `clippy -D warnings` produces no warnings.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P2-02 — Frame wire parity (Bun ⇄ Rust golden corpus)

- **ID:** MT-P2-02
- **Feature / phase:** Phase 2 — `climon-proto` frame codec
- **Preconditions:** Repo checked out; `bun install` done; `cd rust` builds (see
  MT-P2-01).
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Assert the Rust side matches the committed corpus:
   `cd rust && cargo test --test fixtures`.
2. Assert the Bun side matches the *same* corpus:
   `bun test tests/proto-fixtures.test.ts` (from the repo root).
3. Confirm both read the identical file by inspecting
   `fixtures/proto/frames.json` (each entry pairs a frame type + payload with its
   canonical hex encoding).
4. Regeneration check: edit one payload in the generator, regenerate the fixtures,
   and re-run both steps 1–2. Both sides must update to the **same** new hex and
   stay green.

**Expected result:**
- Both the Rust `fixtures` integration test and `tests/proto-fixtures.test.ts`
  pass against the single `fixtures/proto/frames.json` corpus.
- The two implementations produce byte-identical frame encodings, including the
  internally-tagged `terminal-warning` payload whose key order must match JS
  `JSON.stringify` (not alphabetized).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P2-03 — Metadata `color` three-state round-trip

- **ID:** MT-P2-03
- **Feature / phase:** Phase 2 — `SessionMeta`/`SessionMetaPatch`
- **Preconditions:** `cd rust && cargo build --workspace` succeeds.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Run the metadata round-trip tests:
   `cd rust && cargo test -p climon-proto meta`.
2. Inspect the three committed session-meta fixtures under
   `fixtures/proto/session-meta/` and confirm they cover `color` **absent**,
   `color: null`, and `color: "cyan"` (or another named ANSI color).
3. Run the cross-language meta fixtures: `cargo test --test fixtures` (Rust) and
   `bun test tests/proto-fixtures.test.ts` (Bun).

**Expected result:**
- A `SessionMetaPatch` with `color` **absent** serializes with the `color` key
  **omitted** (not `null`).
- A patch with `color: null` serializes back to `null` (an explicit "clear").
- A patch with `color: "cyan"` round-trips to the same named value.
- Both languages agree on all three cases.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P2-04 — License gate + attribution freshness

- **ID:** MT-P2-04
- **Feature / phase:** Phase 2 — license tooling (`cargo-deny` + `cargo-about`)
- **Preconditions:** `cargo-deny` and `cargo-about` installed
  (`cargo install --locked cargo-deny cargo-about`). `cd rust`.
- **Config-matrix cell:** n/a
- **Platforms:** Linux (CI parity); optionally macOS/Windows

**Steps:**
1. Baseline: `cargo deny check` — all of advisories/bans/licenses/sources are ok.
2. Attribution freshness:
   `cargo about generate about.hbs > /tmp/NOTICES.md && diff -u THIRD-PARTY-LICENSES.md /tmp/NOTICES.md`
   — expect **no diff**.
3. Negative test (license gate): temporarily add a dependency whose license is
   **not** in the `deny.toml` allowlist (e.g. a GPL-licensed crate), run
   `cargo deny check`, then revert the change.

**Expected result:**
- Step 1 passes with the current dependency tree.
- Step 2 produces no diff: the committed `THIRD-PARTY-LICENSES.md` is exactly what
  `cargo about` regenerates (idempotent).
- Step 3 makes `cargo deny check` **fail** on the non-allowlisted license,
  proving the gate is live. After reverting, `cargo deny check` is green again.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
