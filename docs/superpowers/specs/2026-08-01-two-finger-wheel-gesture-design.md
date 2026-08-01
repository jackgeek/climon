# Two-finger terminal wheel gesture design

**Date:** 2026-08-01
**Status:** Implemented
**Scope:** Dashboard terminal touch input and shared direction preference

## Summary

Add an exact-two-finger vertical gesture over the dashboard terminal that
dispatches coordinate-bearing pixel wheel events through xterm. The existing
terminal wheel policy remains authoritative:

- normal terminal output with scrollback moves local browser scrollback;
- mouse-aware TUIs receive wheel input through xterm mouse reporting; and
- scrolling stops when the fingers stop moving or are released.

One-finger input, physical mouse/trackpad wheel input, and browser behavior
outside the terminal remain unchanged.

## Gesture recognition

The recognizer is terminal-local and accepts exactly two touches.

It tracks the midpoint of both touches and starts in a pending state. Pending
input is claimed so the browser does not begin page scrolling or
pull-to-refresh while intent is being resolved.

The gesture activates after all of these conditions are met:

- midpoint movement reaches 8px;
- vertical displacement is at least 1.25 times horizontal displacement; and
- the distance between the touches has changed by less than 8px.

Horizontal movement and pinch-like span changes reject the gesture. A touch
count other than two cancels the recognizer. Rejected input remains claimed
until the touch sequence ends.

## Direction and deltas

Each active move emits the incremental vertical midpoint displacement since the
previous move:

- fingers moving up produce positive `deltaY`;
- fingers moving down produce negative `deltaY`; and
- `dashboard.touchWheelInverted` reverses only these synthetic deltas.

The direct displacement is not scaled. Releasing the fingers emits no
additional wheel event.

## DOM adapter

`terminalTouchWheel.ts` installs capture-phase, non-passive listeners on the
terminal container:

- `touchstart` arms the recognizer for exactly two touches;
- `touchmove` advances the recognizer and dispatches accepted wheel deltas;
- `touchend` resets the recognizer; and
- `touchcancel` resets the recognizer.

Synthetic events target `term.element`, not the outer container, and include:

- `deltaMode: DOM_DELTA_PIXEL`;
- midpoint `clientX` / `clientY`;
- midpoint `screenX` / `screenY`;
- `bubbles: true`; and
- `cancelable: true`.

The adapter owns no timers or animation lifecycle. Disposal removes all four
touch listeners.

## Terminal wheel policy

`TerminalView` installs the adapter after `term.open()` and disposes it before
xterm teardown. Synthetic events use the same existing wheel listener as
physical wheel input.

When terminal mouse tracking is disabled and normal-buffer scrollback exists,
the listener prevents the event and calls `term.scrollLines()`. Otherwise it
returns control to xterm so alternate-screen and mouse-aware applications can
receive wheel reporting.

## Shared inversion preference

The setting is:

```text
dashboard.touchWheelInverted = boolean
```

It defaults to `false`, is server/browser scoped, accepted by the CLI, and
dashboard-writable. TypeScript and Rust registries remain byte-for-byte aligned
through the generated config fixtures.

On touch-primary devices, the hamburger menu displays:

- **Invert two-finger scrolling** when the value is `false`; and
- **Use natural two-finger scrolling** when the value is `true`.

`App` reads the cached preference, hydrates it from server health, persists
changes through the dashboard preference endpoint, and passes the current value
to `TerminalView`. A ref-backed getter lets changes affect the next move without
recreating xterm or reinstalling listeners.

## Testing

Automated coverage verifies:

- exactly-two-touch arming and midpoint calculation;
- activation threshold and vertical-intent filtering;
- horizontal and pinch rejection;
- incremental natural and inverted deltas;
- touch-count cancellation;
- no additional wheel event after release;
- coordinate-bearing pixel wheel dispatch;
- one-finger input remains untouched;
- listener installation and disposal;
- local scrollback versus xterm/TUI forwarding;
- TypeScript/Rust config parity and validation;
- dashboard preference collection and persistence; and
- touch-primary menu visibility and labels.

Manual checks live in
`docs/manual-tests/two-finger-terminal-wheel.md`.

## Out of scope

- One-finger terminal scrolling.
- Pinch zoom.
- Configurable sensitivity or activation thresholds.
- Changes to physical mouse or trackpad behavior.
- Changes to daemon, PTY, or server protocols.
