# Rand Dependency Upgrade Design

## Context

Dependabot alert 1 reports `rand 0.7.3` as affected by
`GHSA-cq8v-f236-94qc`. The dependency is introduced transitively by
`human_id 0.1.0`, whose only release pins `rand 0.7.3` and is no longer
maintained. A lockfile-only upgrade cannot move that dependency to a patched
`rand` release.

## Decision

Replace `human_id` with `petname 3.1` and use its medium English word list.
`petname 3.1` uses the patched `rand 0.10` line. Generated session IDs will
retain the user-visible contract of three lowercase ASCII words separated by
hyphens. The vocabulary may change, but metadata paths, collision handling,
and failure behavior will not.

## Changes

- Replace the workspace and `climon-store` dependency on `human_id` with
  `petname`.
- Update the default session-ID generator to select three words from
  `Petnames::medium()` and join them with `-`.
- Keep the existing 50-attempt collision retry loop and validation error.
- Rename implementation-specific functions and comments where necessary so
  they describe the stable session-ID behavior rather than the removed crate.
- Regenerate `rust/Cargo.lock` and `rust/THIRD-PARTY-LICENSES.md`.
- Update the existing store manual test to reference `petname` and its
  attribution instead of `human_id`.

## Error Handling

The medium list is embedded and non-empty, so normal generation should always
produce a name. If the generator API returns no value, treat that as an
internal invariant failure rather than silently returning an invalid or empty
session ID. Existing collision exhaustion remains a surfaced
`StoreError::Validation`.

## Verification

- Run the focused `climon-store` tests, including the three-segment lowercase
  format and collision retry cases.
- Run the Rust workspace test suite and Clippy.
- Run `cargo deny check`.
- Regenerate third-party notices and confirm the committed file is identical.
- Confirm `rust/Cargo.lock` no longer contains `human_id` or a vulnerable
  `rand` version and resolves `petname` with patched `rand 0.10.1` or newer.
