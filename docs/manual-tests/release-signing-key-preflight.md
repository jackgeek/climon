# Release — signing-key preflight blocks mismatched/missing keys

These checks prove that the `Release` workflow refuses to publish on the
canonical `jackgeek/climon` repository unless the `CLIMON_UPDATE_PRIVATE_KEY`
secret is present AND its derived Ed25519 public key equals the public key
embedded in the client from `src/update/pubkey.ts` (`UPDATE_PUBLIC_KEY_B64`).
This prevents shipping an unverifiable release that would break `climon
--update`. Forks (any other repository) skip the check so keyless releases still
build.

The `verify-signing-key` job runs before `build-client` and `release`, so a
missing/mismatched key fails fast with nothing tagged, pushed, or published. The
underlying check is `scripts/verify-signing-key.ts`, runnable locally with
`bun run verify-signing-key`.

Preconditions common to all cases:

- A checkout of the repo with Bun installed (`bun install`).
- Ability to run `bun run verify-signing-key` with a chosen
  `CLIMON_UPDATE_PRIVATE_KEY` value in the environment.
- Generate throwaway keys with `bun scripts/gen-update-keys.ts` when a case
  needs a private key that does or does not match the embedded public key.

---

## MT-SIGNKEY-01 — Matching key passes

- **ID:** MT-SIGNKEY-01
- **Feature:** Release signing-key preflight
- **Preconditions:** Common preconditions; a private key whose public key equals
  `UPDATE_PUBLIC_KEY_B64` in `src/update/pubkey.ts` (the real release key).
- **Config-matrix cell:** Repo = canonical; Key = matching.
- **Platforms:** macOS, Linux, Windows (CI runner: ubuntu-latest).

**Steps:**
1. Export the matching private key:
   ```sh
   export CLIMON_UPDATE_PRIVATE_KEY="<base64 PKCS8 private key matching pubkey.ts>"
   ```
2. Run `bun run verify-signing-key` and note the exit code (`echo $?`).

**Expected result:** Prints `verify-signing-key: OK — signing key matches
embedded public key <key>` and exits 0. In CI the `verify-signing-key` job
succeeds and the release proceeds.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |

---

## MT-SIGNKEY-02 — Mismatched key fails

- **ID:** MT-SIGNKEY-02
- **Feature:** Release signing-key preflight
- **Preconditions:** Common preconditions; a freshly generated keypair whose
  public key does NOT match `UPDATE_PUBLIC_KEY_B64`.
- **Config-matrix cell:** Repo = canonical; Key = mismatched.
- **Platforms:** macOS, Linux, Windows (CI runner: ubuntu-latest).

**Steps:**
1. Generate a throwaway keypair:
   ```sh
   bun scripts/gen-update-keys.ts
   ```
2. Export its `PRIVATE_KEY_PKCS8_B64` as `CLIMON_UPDATE_PRIVATE_KEY` (do NOT
   update `pubkey.ts`).
3. Run `bun run verify-signing-key` and note the exit code.

**Expected result:** Exits non-zero and prints a mismatch message listing BOTH
the expected (embedded) public key and the public key derived from the private
key. In CI the `verify-signing-key` job fails and `build-client`/`release` never
run — nothing is tagged, pushed, or published.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |

---

## MT-SIGNKEY-03 — Missing key fails on the canonical repo

- **ID:** MT-SIGNKEY-03
- **Feature:** Release signing-key preflight
- **Preconditions:** Common preconditions.
- **Config-matrix cell:** Repo = canonical; Key = absent/empty.
- **Platforms:** macOS, Linux, Windows (CI runner: ubuntu-latest).

**Steps:**
1. Ensure the secret is unset:
   ```sh
   unset CLIMON_UPDATE_PRIVATE_KEY
   ```
2. Run `bun run verify-signing-key` and note the exit code.

**Expected result:** Exits non-zero and prints that
`CLIMON_UPDATE_PRIVATE_KEY` is empty and the release would ship unsigned. In CI,
on `jackgeek/climon`, the `verify-signing-key` job fails and blocks the release.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |

---

## MT-SIGNKEY-04 — Forks skip the check (keyless release still builds)

- **ID:** MT-SIGNKEY-04
- **Feature:** Release signing-key preflight
- **Preconditions:** A fork of the repo (any `github.repository` other than
  `jackgeek/climon`) with no `CLIMON_UPDATE_PRIVATE_KEY` secret set.
- **Config-matrix cell:** Repo = fork; Key = absent.
- **Platforms:** CI runner: ubuntu-latest.

**Steps:**
1. On a fork, trigger the `Release` workflow (push to `main`).
2. Observe the `verify-signing-key` job.

**Expected result:** The `verify-signing-key` job succeeds without running the
check step (the `github.repository == 'jackgeek/climon'` guard is false), and the
keyless release proceeds as before (unsigned, no `manifest.json`/`.sig`).

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |
