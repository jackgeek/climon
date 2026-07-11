# Take-control hint wording

## Goal

Shorten the displaced local-terminal hint from:

`Press Space to take control and resize it to this terminal.`

to:

`Press Space to take control.`

## Scope

- Update both Rust renderers: the in-process session host and `climon attach`.
- Update the terminal-control manual test wording.
- Pin the exact text in focused tests for both runtime paths.
- Do not change take-control, resize, replay, or controller behavior.
