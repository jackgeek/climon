# Two-finger terminal wheel gesture design

**Date:** 2026-08-01
**Status:** Approved
**Scope:** Dashboard web terminal, shared dashboard preferences, config parity, tests, and documentation

## Summary

Add a vertically oriented two-finger swipe gesture over the dashboard terminal.
The gesture produces the same wheel input path as a physical wheel:

- normal terminal output scrolls through browser-side xterm scrollback; and
- mouse-aware TUIs receive wheel input through xterm's existing mouse reporting.

One-finger touch behavior and physical mouse/trackpad wheel behavior remain
unchanged. The gesture has bounded release momentum and a shared dashboard
preference for reversing only the synthetic two-finger direction.

## Lessons from previous attempts

The design accounts for earlier implementations that were removed or reverted:

- Commits `05e0a1c8` and `30c52eb3` implemented a custom one-finger
  touch-to-wheel path. It intercepted xterm's native touch handling and was
  removed by `62bd5107` while mobile viewport and key-bar behavior were fixed.
  The new recognizer therefore never claims one-finger input.
- Commit `c0557055` made toolbar chevrons dispatch synthetic wheel events and was
  immediately reverted by `b72ec89e`. A synthetic event must target xterm and
  carry usable terminal coordinates; mouse-reporting applications can otherwise
  drop it.
- Commits `d8754f4f` and `42f4b7c1` established the current wheel split:
  browser-side scrollback is handled locally only when mouse reporting is off
  and the active buffer has history. All other wheel events stay with xterm.
  The new gesture reuses this behavior instead of duplicating it.
- The abandoned `terminal-scroll-wheel` branch added a separate right-edge wheel
  control. This feature acts directly on the terminal surface and does not add
  permanent terminal chrome.

## Architecture

### Pure gesture state

Create a focused module under `src/web/components/` for two-touch recognition
and momentum calculations. It has no React, DOM, xterm, or config dependency.

The state machine has four conceptual states:

1. **Idle** — fewer or more than two touches; no gesture is tracked.
2. **Pending** — exactly two touches are present, but movement has not yet shown
   vertical intent.
3. **Active** — the movement threshold and vertical-dominance test have passed;
   midpoint changes produce wheel deltas.
4. **Momentum** — both touches have lifted after an active gesture; recent
   velocity decays until it reaches the stop threshold.

Pure helpers calculate:

- the midpoint of exactly two touches;
- pending-to-active intent classification;
- signed midpoint movement;
- direction inversion;
- recent vertical velocity;
- bounded momentum displacement and friction decay; and
- cancellation when the touch count changes.

### Terminal integration

`TerminalView` installs native capture-phase `touchstart`, `touchmove`,
`touchend`, and `touchcancel` listeners on its own terminal container. Native
listeners are required so active two-finger movement can use
`preventDefault()` with a non-passive listener and avoid duplicate browser or
xterm handling.

The listeners delegate recognition and math to the pure module. They do not
claim one-finger events. Exactly two touches enter the pending state; once
vertical intent is established, active events are prevented and propagation is
stopped.

For each active movement or momentum frame, `TerminalView` dispatches a
cancelable, bubbling, pixel-mode `WheelEvent` on xterm's root element. The event
includes `clientX`, `clientY`, `screenX`, and `screenY` derived from the
two-touch midpoint. The current `attachCustomWheelEventHandler` remains the
single policy point:

- no mouse tracking plus `buffer.active.baseY > 0` calls `term.scrollLines`; and
- mouse tracking, alternate-buffer input, or no local history returns control to
  xterm so it can forward wheel input to the TUI.

No server protocol or PTY changes are required.

## Gesture behavior

### Activation

- The gesture starts only when exactly two touches are present over the
  terminal.
- Recognition uses the midpoint of the two touches, preventing unequal finger
  movement from doubling the wheel delta.
- A small movement threshold filters taps and placement jitter.
- Vertical displacement must clearly exceed horizontal displacement before the
  gesture activates.
- Horizontal or pinch-like movement emits no wheel input.
- Adding or removing a finger before activation cancels the pending gesture.
- After activation, lifting both fingers together may start momentum. Transitioning
  from two touches to one, or adding a third touch, cancels without momentum.
- A new touch immediately cancels any running momentum.

The initial constants are implementation details kept together in the pure
module and covered by tests. They should be conservative enough to reject
placement jitter without making the gesture feel delayed.

### Direction and inversion

The default is trackpad-natural:

- midpoint moves up -> positive wheel `deltaY` -> scroll toward newer/lower
  content; and
- midpoint moves down -> negative wheel `deltaY` -> scroll toward older/upper
  content.

The shared boolean setting `dashboard.touchWheelInverted` defaults to `false`.
When true, only two-finger synthetic deltas are multiplied by `-1`. It does not
change physical mouse wheels, browser trackpads, one-finger touch scrolling, or
toolbar key actions.

### Momentum

While active, recent midpoint samples are retained in a short rolling window.
When the last two touches lift, their vertical velocity starts a
`requestAnimationFrame` momentum loop.

Each frame:

- caps elapsed time so returning from a backgrounded tab cannot cause a large
  jump;
- converts velocity and elapsed time into displacement;
- emits a coordinate-bearing wheel event;
- applies friction; and
- stops below a minimum velocity.

`touchcancel`, a touch-count change, component teardown, and a new touch all
cancel momentum. Momentum is bounded by the same wheel policy as direct
movement; it cannot bypass xterm's mouse-mode handling.

## Shared preference and dashboard UI

Register `dashboard.touchWheelInverted` as:

- type `boolean`;
- default `false`;
- scope `server, browser`;
- accepted as CLI config input;
- dashboard-writable; and
- validated as a boolean.

Keep the TypeScript registry and `rust/climon-config` registry byte-for-byte
equivalent in purpose, type, default, and scope. Add the corresponding field to
`DashboardConfig` and a constant to `src/dashboard-preference-keys.ts`.

`App` initializes the preference from the local cache, reconciles it from the
server health payload, passes it to `TerminalView`, and persists optimistic
toggles through `setDashboardPreference`.

Add a sidebar menu item beside **Pin key bar**, visible only on touch-primary
devices:

- **Invert two-finger scrolling** when false; and
- **Use natural two-finger scrolling** when true.

The menu condition uses touch-primary capability rather than only the narrow
mobile breakpoint, so tablets and wide touch devices can configure the gesture.

## Error handling

- Missing xterm elements, missing touch coordinates, zero deltas, and invalid
  timing emit no wheel event.
- Unexpected touch-count changes cancel the gesture instead of guessing.
- Preference persistence keeps the existing optimistic cache behavior and logs
  server write failures through the established preference logger.
- Gesture event handlers do not catch broad errors or silently alter physical
  wheel behavior.

## Testing

### Unit tests

Cover the pure gesture module:

- exactly two touches enter pending state;
- one or three touches remain idle;
- midpoint calculation;
- movement threshold and vertical dominance;
- horizontal and pinch-like rejection;
- natural and inverted delta mapping;
- cancellation when touch count changes;
- rolling velocity sampling;
- friction decay and stop threshold;
- elapsed-frame cap; and
- momentum cancellation.

### Terminal integration tests

Cover:

- capture-phase, non-passive two-finger listener wiring;
- one-finger events are not prevented or stopped;
- active two-finger movement dispatches a pixel-mode `WheelEvent`;
- synthetic events include terminal coordinates;
- the inversion preference affects only synthetic gesture deltas;
- active gestures and momentum use the existing local-scrollback path when
  appropriate;
- mouse-tracking mode remains available for xterm/TUI forwarding; and
- teardown removes listeners and cancels animation frames.

### Preference and config tests

Update tests for:

- TypeScript and Rust config registry parity;
- default config generation;
- dashboard-writable allowlisting and validation;
- server collection and persistence;
- health-payload hydration;
- cache initialization;
- touch-primary sidebar visibility;
- menu labels and toggle persistence; and
- generated config fixtures and documentation.

## Documentation and manual checks

Because this changes the config registry, regenerate:

- `fixtures/config/` with `bun scripts/gen-config-fixtures.ts`; and
- generated config docs/comments with `bun run docs:config`.

Update:

- `docs/usage.md`;
- `docs/features.md`;
- `docs/manual-tests/README.md`; and
- a new manual-test document for the gesture.

Manual checks cover:

- local scrollback in normal output;
- wheel forwarding in a mouse-aware TUI;
- one-finger behavior remains unchanged;
- diagonal and pinch-like motion emit no wheel input;
- natural and inverted directions;
- preference persistence across reloads and another browser/device;
- momentum and grab-to-stop;
- touch cancellation and finger-count changes; and
- narrow-phone and wide-tablet PWA layouts.

## Out of scope

- Changing physical mouse or trackpad wheel direction.
- Replacing xterm's one-finger touch behavior.
- Adding a visible edge wheel or other permanent terminal control.
- Configurable sensitivity, friction, thresholds, or momentum duration.
- Server protocol, daemon, PTY, or Rust client runtime changes.
