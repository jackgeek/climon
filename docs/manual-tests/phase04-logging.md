# Phase 4 — `climon-logging` crate

These cases prove that the ported logging subsystem (`rust/climon-logging`) builds
and tests on every supported OS, that secret **redaction** is faithful to the
TypeScript/pino implementation (enforced by a shared golden corpus asserted by both
Rust and Bun), that log **levels**, **pretty** terminal routing, and **file sinks**
behave as the TS client does, and that the license tooling stays green with no new
crates introduced.

Background: Phase 4 adds the `climon-logging` library crate, a sync, dependency-light
(only `serde_json`) port of `src/logging/*` — log levels with pino numeric ordering,
secret redaction, pretty terminal formatting, file sinks, the process-global logger
factory, and CLI I/O tee helpers. The Application Insights telemetry transport and
transform (`appinsights*.ts`) are intentionally **not** ported: the transport is
server-only (the Azure SDK must never reach the client binary) and the transform's only
consumer is that server-side stream, with an out-of-scope i18n dependency. See the
[Phase 4 plan](../superpowers/plans/2026-06-19-phase04-climon-logging.md) and the
[master plan](../superpowers/specs/2026-06-17-rust-client-rewrite-master-plan.md).

No configuration matrix applies to this phase: it is single-environment per OS. Run the
cases independently on each platform listed.

---

## MT-P4-01 — Crate builds, lints, and tests on all 3 OSes

- **ID:** MT-P4-01
- **Feature / phase:** Phase 4 — `climon-logging` build/test
- **Preconditions:** Repo checked out; a stable Rust toolchain with `rustfmt` +
  `clippy`.
- **Config-matrix cell:** n/a
- **Platforms:** macOS (arm64), Linux (x64), Windows (x64)

**Steps:**
1. From the repo root: `cd rust`.
2. Build the workspace: `cargo build --workspace`.
3. Run the whole suite: `cargo test --workspace`.
4. Run the lint gates: `cargo fmt --all --check` and
   `cargo clippy --workspace --all-targets -- -D warnings`.

**Expected result:**
- `cargo build --workspace` compiles `climon-rs`, `climon-proto`, and the new
  `climon-logging` with no errors.
- `cargo test --workspace` is green on each platform (the `climon-logging` unit tests,
  the `redact_fixture` integration test, and the existing crates' tests all pass).
- `fmt --check` reports no diffs and `clippy -D warnings` produces no warnings.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P4-02 — Redaction parity (Bun ⇄ Rust golden corpus)

- **ID:** MT-P4-02
- **Feature / phase:** Phase 4 — secret redaction
- **Preconditions:** `bun install` done; `cd rust` builds (see MT-P4-01).
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Assert the Rust side matches the committed corpus:
   `cd rust && cargo test -p climon-logging --test redact_fixture`.
2. Assert the Bun side matches the *same* corpus:
   `bun test tests/logging-redact-fixture.test.ts` (from the repo root).
3. Confirm both read the identical file `fixtures/logging/redact.json` (each case pairs an
   `input` record with the `expected` post-redaction record).
4. Negative check: edit one case's `input` to add a new secret key (e.g. `"token"` deep
   inside an object) but leave `expected` un-redacted, re-run steps 1–2 — both sides must
   now **fail** identically; then revert.

**Expected result:**
- Both the Rust integration test and the Bun test pass against the single
  `fixtures/logging/redact.json` corpus.
- Every secret path from `src/logging/redact.ts` (`connectionString`, `authorization`,
  `password`, `token`, `auth`, `accessToken`, `tunnelToken`, and their `*.`-wildcard
  one-level-deep forms) is censored to `[REDACTED]`; non-secret fields are untouched.
- The negative check fails on **both** sides, proving the corpus is actually asserted.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P4-03 — Level resolution, pretty routing, and file sinks

- **ID:** MT-P4-03
- **Feature / phase:** Phase 4 — levels, pretty stream, sinks, logger factory
- **Preconditions:** `cd rust && cargo build --workspace` succeeds.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Run the focused unit tests:
   `cd rust && cargo test -p climon-logging level pretty sinks logger cli_io`.
2. Confirm the level precedence matches `resolveLevel`: `CLIMON_LOG_LEVEL` env beats
   config, an invalid env value falls through to config, `NODE_ENV=test` forces `silent`
   when nothing else is set, otherwise the default is `trace`.
3. Confirm pretty routing: info/warn render to *out*, error/fatal to *err*, only the
   message is printed (no level/timestamp/pid), severity colour wraps the message, and a
   suspended terminal mutes both streams.
4. Confirm sinks: `logs/<role>/` layout; daemon files are `<sessionId>.log`; other roles
   are `<utc-stamp>-<pid>.log`; a `silent` logger creates no files; debug records still
   reach the **file** for terminal roles even though the pretty sink is info-gated.

**Expected result:**
- All focused unit tests pass.
- The observable level/pretty/sink behaviour matches the TypeScript client (the Rust
  tests mirror `tests/logging-level.test.ts`, `tests/logging-pretty.test.ts`,
  `tests/logging-factory.test.ts`, `tests/logger-install-id.test.ts`, and
  `tests/logging-cli-io.test.ts`).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-P4-04 — License gate + attribution freshness (no new crates)

- **ID:** MT-P4-04
- **Feature / phase:** Phase 4 — license tooling (`cargo-deny` + `cargo-about`)
- **Preconditions:** `cargo-deny` and `cargo-about` installed
  (`cargo install --locked cargo-deny cargo-about`). `cd rust`.
- **Config-matrix cell:** n/a
- **Platforms:** Linux (CI parity); optionally macOS/Windows

**Steps:**
1. Baseline: `cargo deny check` — advisories/bans/licenses/sources all ok.
2. Attribution freshness:
   `cargo about generate about.hbs > ../.phase04-notices.md && diff -u THIRD-PARTY-LICENSES.md ../.phase04-notices.md`
   — expect **no diff** — then `rm ../.phase04-notices.md`.

**Expected result:**
- Step 1 passes with the current dependency tree.
- Step 2 produces no diff: `climon-logging` adds only `serde_json` (already in the
  workspace tree via `climon-proto`), so `Cargo.lock` and `THIRD-PARTY-LICENSES.md` are
  unchanged by this phase.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
