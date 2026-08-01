# PTY Output Attention Detection Design

## Goal

Make `needs-attention` depend on terminal output inactivity instead of sampled
screen fingerprints. This removes sampling aliases and renderer differences from
attention detection.

## Detection model

The daemon records activity whenever its PTY reader receives a non-empty output
chunk. A fixed one-second timer checks the elapsed monotonic time since the most
recent output:

- After `attention.idleSeconds` with no PTY output, the session transitions to
  `needs-attention`.
- Any subsequent PTY output transitions `needs-attention` or `acknowledged` back
  to `running` immediately and starts a fresh idle window.
- An acknowledged session remains `acknowledged` indefinitely while no new PTY
  output arrives.
- Values of `attention.idleSeconds` less than or equal to zero continue to
  disable detection.

The attention reason becomes `No terminal output for Ns`.

## State and acknowledgement safety

The detector tracks only monotonic output time plus its flagged and acknowledged
states. It no longer receives terminal fingerprints, has no sampling jitter, and
has no resize-settle state.

The host maintains an output generation counter incremented for every PTY output
chunk. When attention is flagged, the host stores the current generation beside
the existing `attentionMatchedAt` token. A browser acknowledgement is accepted
only when both the token and generation still match. This preserves stale
acknowledgement protection without comparing screen fingerprints.

## Terminal grid

The headless VT grid remains in place because it is still required for terminal
repainting and smart-notification snippets. Its fingerprint is no longer used by
attention detection or acknowledgement validation.

## Resize behavior

A resize itself is not activity. If the child responds to `SIGWINCH` by emitting
PTY output, that output is activity under the new model. Therefore an
acknowledged session may transition to `running` after a resize-triggered redraw
and may become `needs-attention` again after a fresh silent window.

## Configuration and documentation

`attention.idleSeconds` keeps its name and type, but its documented purpose
changes from an unchanged rendered grid to no terminal output. The TypeScript and
Rust config registries, generated config fixtures/docs, architecture, usage,
feature catalogue, and Phase 7 manual checks must describe the new behavior.

The abandoned idle-sampling-jitter design and plan are removed from the branch.

## Testing

Unit tests cover:

- Flagging after the configured period without output.
- Output resetting the idle clock.
- Output clearing flagged and acknowledged states.
- Acknowledgement suppressing re-flagging until output arrives.
- Disabled detection.
- Output-generation acknowledgement validation, including stale tokens and
  output arriving after attention was flagged.

Integration tests continue to verify metadata transitions and update their
expected reason text. The full `climon-session` and config parity suites validate
the behavior and regenerated documentation.

## Non-goals

The daemon does not attempt to distinguish meaningful output from redundant
redraws, title/progress escape sequences, terminal queries, or resize-triggered
output. Every PTY output chunk counts as activity.
