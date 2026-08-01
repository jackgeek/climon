# Changelog 3.3 Backfill Design

## Goal

Restore the missing installer-facing changelog history for releases `3.3.0`
through `3.3.3`.

## Source of Truth

Reconstruct each entry from the actual diff between consecutive release tags.
Prefer concise user-visible outcomes over exhaustive commit, dependency, or CI
details. Include a maintenance summary when a release had no runtime behavior
change.

## Entries

Prepend these entries to `CHANGELOG.json` in descending version order:

- `3.3.3`
  - Prevent local terminals from freezing when a console write stalls by moving
    terminal output off the shared session-state lock.
  - Refresh Rust and JavaScript dependencies and regenerate third-party license
    notices.
- `3.3.2`
  - Show the terminal Select/copy button on all devices instead of limiting it
    to touch devices.
- `3.3.1`
  - Harden tag-driven release and back-merge automation, including workflow
    permissions.
- `3.3.0`
  - Make Microsoft dev-tunnel failures actionable and retry transient failures
    with capped backoff across dashboard and remote-session connections.
  - Fix dashboard session lists periodically going blank.
  - Copy selected captured terminal text with whitespace collapsed to a clean
    single line.

## Validation

Parse `CHANGELOG.json` with Bun, run the focused Bun changelog test, and run the
focused Rust changelog tests in `climon-install`.
