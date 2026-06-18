# Phase 10 — `climon-update` (self-update)

These cases prove that the ported `climon update` flow (`rust/climon-update`,
wired into `rust/climon-cli`) verifies, decrypts, and applies update artifacts
produced by the **unchanged** Bun release pipeline, and that the binary swap is
atomic and never kills a running session or process.

Background: Phase 10 ports `src/update/verify.ts`, `pubkey.ts`,
`crypto-envelope.ts`, `manifest.ts`, `download.ts`, `state.ts`, `swap.ts`,
`check.ts`, `launch-hooks.ts`, `update-cli.ts`, and `update-cmd.ts` into the
`climon-update` crate, plus `src/install/install-manifest.ts`. The crypto is
**byte-for-byte interop**: detached Ed25519 over the raw artifact bytes
(`ed25519-dalek`), and the `aes-256-gcm-scrypt-v1` envelope
(`[MAGIC "CLMENV1"(7)][salt(16)][iv(12)][tag(16)][ciphertext]`, scrypt N=32768
r=8 p=1). The embedded public key is read from `src/update/pubkey.ts` at build
time (`build.rs`) so it can never drift from the Bun client. The HTTP client is
`ureq` + `native-tls` (OS trust store) to keep the license allowlist clean. See
the [master plan](../superpowers/specs/2026-06-17-rust-client-rewrite-master-plan.md)
and the [Phase 10 plan](../superpowers/plans/2026-06-18-phase10-climon-update.md).

All cases isolate state with a temp `CLIMON_HOME` so they never touch a real
`~/.climon`, and use a temporary install directory so a real install is never
modified. Where a release server is needed, a local HTTP server serving a
hand-built manifest + signed artifact stands in for `climon-releases`.

---

## MT-P10-01 — `climon-update` builds, tests, lints, and deny-checks

- **ID:** MT-P10-01
- **Feature / phase:** Phase 10 — `climon-update` crate
- **Preconditions:** Repo checked out; stable Rust toolchain with `rustfmt` +
  `clippy`; `cargo-deny` + `cargo-about` installed; Bun installed for the
  cross-language fixture test.
- **Config-matrix cell:** all
- **Platforms:** macOS (arm64), Linux (x64), Windows (x64)

**Steps:**
1. From the repo root: `cd rust`.
2. Build: `cargo build -p climon-update`.
3. Test: `cargo test -p climon-update` (unit tests + `fixtures` parity test).
4. Lint: `cargo fmt --all --check` and
   `cargo clippy --workspace --all-targets -- -D warnings`.
5. License gate: `cargo deny check`; regenerate and confirm idempotent:
   `cargo about generate about.hbs > THIRD-PARTY-LICENSES.md` (no diff).
6. Cross-language fixtures (from repo root): `bun test tests/update-fixtures.test.ts`.

**Expected:** All build/test/lint/deny steps pass; `cargo about` output is
idempotent; the Bun fixture test confirms crypto parity both directions.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P10-02 — `climon update` happy path (verified, applied)

- **ID:** MT-P10-02
- **Preconditions:** A local HTTP server serving a `manifest.json` whose
  `version` is newer than the running `climon` and whose artifact key matches
  this OS/arch; a zip artifact (`install`, `climon-server`, `climon-beta`) signed
  with a test Ed25519 key whose public key is set as `UPDATE_PUBLIC_KEY_B64`
  (or use the `runUpdateCommand`/`run_update_command` test harness). A temp
  install dir populated with old `climon`/`climon-server`/`climon-beta` files.
- **Config-matrix cell:** Unix (atomic rename swap)
- **Platforms:** macOS (arm64), Linux (x64)

**Steps:**
1. Point the updater at the local manifest URL and temp install dir.
2. Run the update (`climon update`, or the `run_update_command` harness).
3. Inspect the install dir contents and the printed status.

**Expected:** Status `updated`; `climon`, `climon-server`, and `climon-beta` now
contain the new bytes; the swapped-in files are executable; no `.tmp-*`
leftovers remain. The reference Rust unit test is
`update_cmd::tests::verified_update_replaces_install_files_on_unix`.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P10-03 — signature mismatch is refused (no changes)

- **ID:** MT-P10-03
- **Preconditions:** Same as MT-P10-02 but the artifact is signed with the wrong
  key (or the embedded public key does not match the signer).
- **Config-matrix cell:** all
- **Platforms:** all

**Steps:**
1. Run the update against the tampered/wrong-key artifact.
2. Inspect the install dir and the printed status.

**Expected:** Status `verify-failed`; the message
"Update aborted: signature verification failed. No changes were made." is
printed; every install file still has its **old** bytes. Reference test:
`update_cmd::tests::tampered_artifact_is_rejected_and_files_are_unchanged`.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P10-04 — encrypted artifact decrypts then verifies then installs

- **ID:** MT-P10-04
- **Preconditions:** Manifest has `"encryption": "aes-256-gcm-scrypt-v1"`; the
  artifact is the signed zip wrapped in a `CLMENV1` envelope with a known
  password; `update.password` is set in the global config (or passed to the
  harness).
- **Config-matrix cell:** encrypted releases
- **Platforms:** macOS (arm64), Linux (x64)

**Steps:**
1. Set `climon config set update.password <pw> --global` (per-machine).
2. Run the update against the encrypted manifest.
3. Inspect the install dir and status.
4. Repeat with a **wrong** password.

**Expected:** With the right password: status `updated`, files replaced. With
the wrong password: status `decrypt-failed`, message "Update aborted: could not
decrypt the release (wrong or rotated password). No changes were made.", and the
install files are unchanged. Reference tests:
`update_cmd::tests::decrypts_verifies_and_installs_an_encrypted_artifact` and
`wrong_password_yields_decrypt_failed_and_leaves_files_unchanged`.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P10-05 — atomic swap leaves running sessions untouched

- **ID:** MT-P10-05
- **Preconditions:** At least one live `climon` session running (its daemon
  holds the current `climon`/`climon-server` binaries); a verified newer update
  available.
- **Config-matrix cell:** Unix (atomic rename swap)
- **Platforms:** macOS (arm64), Linux (x64)

**Steps:**
1. Start a monitored session (`climon` bare → shell) and run a long-lived
   command in it (e.g. `tail -f` / `top`).
2. In a second terminal, apply the update (`climon update`).
3. Observe the running session, then start a **new** session.

**Expected:** The update never kills or signals the running session/daemon —
the long-lived command keeps running uninterrupted (the old inode stays mapped
until that process exits). The binary on disk is replaced atomically; a **new**
`climon` launch runs the new version. The status message notes that new sessions
(or a server restart) pick up the update. The no-kill rename behaviour is pinned
by `swap::tests::replacing_a_file_held_open_by_a_reader_still_succeeds`.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## MT-P10-06 — background check + update banner on launch

- **ID:** MT-P10-06
- **Preconditions:** Temp `CLIMON_HOME`; the global config has a cached
  `update.availableVersion` newer than the running version (simulate by
  `climon config set update.availableVersion 999.0.0 --global`), and
  `update.auto` is **false** (default).
- **Config-matrix cell:** all
- **Platforms:** all

**Steps:**
1. With the cached newer version set, run `climon` (bare → shell) or
   `climon run -- <cmd>`.
2. Observe stderr at launch.
3. Set `update.availableVersion` equal to the running version and relaunch.
4. Separately, confirm the background check throttling: run
   `climon __update-check` and inspect `update.lastCheck` in the config; rerun a
   launch within 24h and confirm a second `__update-check` is not spawned.

**Expected:** Step 2 prints a one-line banner
"Update <current> → 999.0.0 available — run `climon --update`". Step 3 prints
**no** banner (cache stale-equal). The background check records an ISO-8601
`update.lastCheck` and is throttled to once per 24h. With `update.auto=true`,
the banner step instead spawns a detached `climon update` (no banner) and never
blocks the launch. Reference tests:
`launch_hooks::tests::*` and `state::tests::*`.

| Date | Tester | OS | Result | Notes |
|---|---|---|---|---|
| | | | | |
