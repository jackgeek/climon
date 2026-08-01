# Idle Sampling Jitter Design

## Goal

Reduce false `needs-attention` transitions caused by the one-second sampler
repeatedly observing the same phase of a periodic terminal animation.

## Scope

Change only the idle sampling schedule in `rust/climon-session`. Preserve:

- `attention.idleSeconds` wall-clock semantics.
- The existing text-only terminal fingerprint.
- Resize settling and acknowledgement behavior.
- Session metadata and attention transition behavior.

## Design

The idle sampling thread will choose a fresh delay before every sample. Each
delay will be an integer from 800 through 1000 milliseconds, inclusive.

The delay sequence will come from a small non-cryptographic pseudo-random
generator owned by the idle thread and seeded from the session identity. This
keeps the change dependency-free and gives different sessions different sampling
phases. Randomness is not security-sensitive; its only purpose is to avoid a
fixed cadence.

Elapsed idle time will continue to use the daemon's monotonic clock. Therefore,
jitter changes when fingerprints are observed but does not redefine the
configured idle threshold.

## Testing

Focused unit tests will verify that:

- Every generated delay is within 800–1000 milliseconds.
- A generated sequence contains varying delays rather than a fixed interval.

Existing `ScreenIdleDetector` tests continue to cover attention timing and state
transitions because that pure detector is unchanged.

## Non-goals

This change does not detect cursor-only, colour-only, OSC-only, or other updates
that do not alter the current text fingerprint. It reduces sampling aliasing but
does not make all terminal activity visible to the detector.
