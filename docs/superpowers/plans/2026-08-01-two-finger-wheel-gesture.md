# Two-Finger Terminal Wheel Gesture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a vertically intentional two-finger terminal gesture with bounded momentum that follows xterm's physical-wheel path, plus a shared dashboard preference that reverses only this gesture.

**Architecture:** A pure `twoFingerWheelGesture.ts` module owns touch midpoint, intent, inversion, velocity, and momentum math. A DOM-focused `terminalTouchWheel.ts` adapter owns listeners, animation frames, and coordinate-bearing synthetic `WheelEvent` dispatch; `TerminalView` installs that adapter and continues using its existing wheel handler to choose local scrollback versus TUI mouse forwarding. The inversion preference uses the existing dashboard-writable config and sidebar mechanisms.

**Tech Stack:** TypeScript ESM, React 19, `@xterm/xterm` 6, Fluent UI v9, Bun tests, Rust config-registry parity.

**Spec:** `docs/superpowers/specs/2026-08-01-two-finger-wheel-gesture-design.md`

---

## File Structure

- **Create** `src/web/components/twoFingerWheelGesture.ts` — pure touch-intent, delta, velocity, and momentum calculations.
- **Create** `src/web/components/terminalTouchWheel.ts` — terminal-local native touch listeners, animation lifecycle, and synthetic wheel dispatch.
- **Create** `tests/two-finger-wheel-gesture.test.ts` — pure gesture and momentum tests.
- **Create** `tests/terminal-touch-wheel.test.ts` — DOM adapter tests with fake targets and animation scheduler.
- **Modify** `src/web/components/TerminalView.tsx` — add the inversion prop and install the adapter beside existing xterm input handlers.
- **Modify** `tests/terminal-view.test.ts` — assert adapter wiring and preservation of the existing wheel policy.
- **Modify** `src/config-settings.ts` — register `dashboard.touchWheelInverted`.
- **Modify** `rust/climon-config/src/config_settings.rs` — mirror the setting in the Rust registry.
- **Modify** `src/types.ts` — add the dashboard config field.
- **Modify** `src/dashboard-preference-keys.ts` — add the shared preference key.
- **Modify** `tests/config-settings.test.ts` — cover default, allowlist, and validation.
- **Modify** `tests/dashboard-preferences-server.test.ts` — cover collection and persistence.
- **Regenerate** `fixtures/config/*` and config documentation through the existing scripts.
- **Modify** `src/web/App.tsx` — cache, hydrate, persist, pass, and toggle the preference.
- **Modify** `src/web/sidebar-utils.ts` — inversion menu label helper.
- **Modify** `src/web/components/Sidebar.tsx` — touch-primary-only menu item.
- **Modify** `tests/app-layout.test.ts` and `tests/sidebar-menu.test.ts` — preference wiring and menu visibility.
- **Create** `docs/manual-tests/two-finger-terminal-wheel.md` — manual browser/PWA checks.
- **Modify** `docs/manual-tests/README.md`, `docs/usage.md`, and `docs/features.md` — index and user-facing documentation.

---

### Task 1: Pure two-finger gesture and momentum math

**Files:**
- Create: `tests/two-finger-wheel-gesture.test.ts`
- Create: `src/web/components/twoFingerWheelGesture.ts`

- [ ] **Step 1: Write the failing pure-logic tests**

Create `tests/two-finger-wheel-gesture.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  beginTwoFingerGesture,
  moveTwoFingerGesture,
  finishTwoFingerGesture,
  stepWheelMomentum,
  isWheelMomentumActive,
  type GestureTouch
} from "../src/web/components/twoFingerWheelGesture.js";

const touch = (x: number, y: number): GestureTouch => ({
  clientX: x,
  clientY: y,
  screenX: x + 100,
  screenY: y + 200
});

describe("twoFingerWheelGesture", () => {
  test("starts pending only for exactly two touches", () => {
    expect(beginTwoFingerGesture([touch(0, 0)], 0).phase).toBe("idle");
    expect(beginTwoFingerGesture([touch(0, 0), touch(20, 20)], 0)).toMatchObject({
      phase: "pending",
      origin: { clientX: 10, clientY: 10 }
    });
    expect(beginTwoFingerGesture([touch(0, 0), touch(20, 20), touch(30, 30)], 0).phase).toBe("idle");
  });

  test("rejects jitter below the activation threshold", () => {
    const start = beginTwoFingerGesture([touch(0, 100), touch(20, 100)], 0);
    const move = moveTwoFingerGesture(start, [touch(1, 95), touch(21, 95)], 16, false);

    expect(move.claimed).toBe(true);
    expect(move.deltaY).toBe(0);
    expect(move.state.phase).toBe("pending");
  });

  test("activates only for vertically dominant movement", () => {
    const start = beginTwoFingerGesture([touch(0, 100), touch(20, 100)], 0);
    const vertical = moveTwoFingerGesture(start, [touch(1, 85), touch(21, 85)], 16, false);
    const horizontal = moveTwoFingerGesture(start, [touch(18, 98), touch(38, 98)], 16, false);

    expect(vertical.state.phase).toBe("active");
    expect(vertical.deltaY).toBe(15);
    expect(horizontal.state.phase).toBe("rejected");
    expect(horizontal.deltaY).toBe(0);
  });

  test("rejects pinch-like spread changes", () => {
    const start = beginTwoFingerGesture([touch(0, 100), touch(20, 100)], 0);
    const pinch = moveTwoFingerGesture(start, [touch(-10, 100), touch(30, 100)], 16, false);

    expect(pinch.state.phase).toBe("rejected");
    expect(pinch.deltaY).toBe(0);
  });

  test("uses the midpoint and emits incremental natural wheel deltas", () => {
    const start = beginTwoFingerGesture([touch(0, 100), touch(20, 120)], 0);
    const first = moveTwoFingerGesture(start, [touch(0, 80), touch(20, 100)], 20, false);
    const second = moveTwoFingerGesture(first.state, [touch(0, 75), touch(20, 95)], 30, false);

    expect(first.deltaY).toBe(20);
    expect(second.deltaY).toBe(5);
    expect(second.point).toMatchObject({ clientX: 10, clientY: 85 });
  });

  test("inverts only the produced synthetic delta", () => {
    const start = beginTwoFingerGesture([touch(0, 100), touch(20, 100)], 0);
    const move = moveTwoFingerGesture(start, [touch(0, 80), touch(20, 80)], 20, true);

    expect(move.deltaY).toBe(-20);
  });

  test("touch-count changes cancel without momentum", () => {
    const start = beginTwoFingerGesture([touch(0, 100), touch(20, 100)], 0);
    const active = moveTwoFingerGesture(start, [touch(0, 80), touch(20, 80)], 20, false);
    const changed = moveTwoFingerGesture(active.state, [touch(0, 70)], 30, false);

    expect(changed.state.phase).toBe("idle");
    expect(finishTwoFingerGesture(changed.state, 0, false)).toBeNull();
  });

  test("finishing an active gesture returns recent signed velocity", () => {
    const start = beginTwoFingerGesture([touch(0, 100), touch(20, 100)], 0);
    const first = moveTwoFingerGesture(start, [touch(0, 80), touch(20, 80)], 20, false);
    const second = moveTwoFingerGesture(first.state, [touch(0, 60), touch(20, 60)], 40, false);
    const momentum = finishTwoFingerGesture(second.state, 0, false);

    expect(momentum?.velocity).toBeCloseTo(1, 5);
    expect(momentum?.point.clientY).toBe(60);
  });

  test("a one-touch remainder cancels without momentum", () => {
    const start = beginTwoFingerGesture([touch(0, 100), touch(20, 100)], 0);
    const active = moveTwoFingerGesture(start, [touch(0, 80), touch(20, 80)], 20, false);

    expect(finishTwoFingerGesture(active.state, 1, false)).toBeNull();
  });

  test("momentum caps long frames and decays below the stop threshold", () => {
    const first = stepWheelMomentum(1, 1000);
    expect(first.elapsedMs).toBe(48);
    expect(first.deltaY).toBe(48);
    expect(first.velocity).toBeLessThan(1);

    let velocity = first.velocity;
    let steps = 0;
    while (isWheelMomentumActive(velocity) && steps < 1000) {
      velocity = stepWheelMomentum(velocity, 16).velocity;
      steps += 1;
    }
    expect(steps).toBeLessThan(1000);
    expect(isWheelMomentumActive(velocity)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test tests/two-finger-wheel-gesture.test.ts
```

Expected: FAIL because `src/web/components/twoFingerWheelGesture.ts` does not exist.

- [ ] **Step 3: Implement the pure gesture module**

Create `src/web/components/twoFingerWheelGesture.ts`:

```ts
export interface GestureTouch {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
}

export interface GesturePoint extends GestureTouch {}

interface VelocitySample {
  clientY: number;
  timeStamp: number;
}

export type TwoFingerGestureState =
  | { phase: "idle" | "rejected" }
  | {
      phase: "pending" | "active";
      origin: GesturePoint;
      last: GesturePoint;
      originSpan: number;
      samples: VelocitySample[];
    };

export interface GestureMove {
  state: TwoFingerGestureState;
  claimed: boolean;
  deltaY: number;
  point: GesturePoint | null;
}

export interface WheelMomentum {
  velocity: number;
  point: GesturePoint;
}

export const GESTURE_ACTIVATION_PX = 8;
export const PINCH_REJECTION_PX = 8;
export const VERTICAL_DOMINANCE_RATIO = 1.25;
export const VELOCITY_WINDOW_MS = 100;
export const MOMENTUM_FRICTION_PER_FRAME = 0.92;
export const MIN_MOMENTUM_VELOCITY = 0.02;
export const MAX_MOMENTUM_FRAME_MS = 48;

const IDLE: TwoFingerGestureState = { phase: "idle" };

function midpoint(touches: readonly GestureTouch[]): GesturePoint | null {
  if (touches.length !== 2) {
    return null;
  }
  const [a, b] = touches;
  return {
    clientX: (a.clientX + b.clientX) / 2,
    clientY: (a.clientY + b.clientY) / 2,
    screenX: (a.screenX + b.screenX) / 2,
    screenY: (a.screenY + b.screenY) / 2
  };
}

function touchSpan(touches: readonly GestureTouch[]): number {
  if (touches.length !== 2) {
    return 0;
  }
  return Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY
  );
}

function trimSamples(samples: VelocitySample[], newest: number): VelocitySample[] {
  return samples.filter((sample) => newest - sample.timeStamp <= VELOCITY_WINDOW_MS);
}

function direction(inverted: boolean): number {
  return inverted ? -1 : 1;
}

export function beginTwoFingerGesture(
  touches: readonly GestureTouch[],
  timeStamp: number
): TwoFingerGestureState {
  const point = midpoint(touches);
  if (!point) {
    return IDLE;
  }
  return {
    phase: "pending",
    origin: point,
    last: point,
    originSpan: touchSpan(touches),
    samples: [{ clientY: point.clientY, timeStamp }]
  };
}

export function moveTwoFingerGesture(
  state: TwoFingerGestureState,
  touches: readonly GestureTouch[],
  timeStamp: number,
  inverted: boolean
): GestureMove {
  const point = midpoint(touches);
  if (!point || state.phase === "idle") {
    return { state: IDLE, claimed: false, deltaY: 0, point: null };
  }
  if (state.phase === "rejected") {
    return { state, claimed: true, deltaY: 0, point };
  }

  const totalX = point.clientX - state.origin.clientX;
  const totalY = point.clientY - state.origin.clientY;
  const distance = Math.hypot(totalX, totalY);
  let phase = state.phase;

  if (
    phase === "pending" &&
    Math.abs(touchSpan(touches) - state.originSpan) >= PINCH_REJECTION_PX
  ) {
    return { state: { phase: "rejected" }, claimed: true, deltaY: 0, point };
  }

  if (phase === "pending" && distance >= GESTURE_ACTIVATION_PX) {
    if (Math.abs(totalY) < Math.abs(totalX) * VERTICAL_DOMINANCE_RATIO) {
      return { state: { phase: "rejected" }, claimed: true, deltaY: 0, point };
    }
    phase = "active";
  }

  const samples = trimSamples(
    [...state.samples, { clientY: point.clientY, timeStamp }],
    timeStamp
  );
  const deltaY =
    phase === "active"
      ? (state.last.clientY - point.clientY) * direction(inverted)
      : 0;

  return {
    state: {
      phase,
      origin: state.origin,
      last: point,
      originSpan: state.originSpan,
      samples
    },
    claimed: true,
    deltaY,
    point
  };
}

export function finishTwoFingerGesture(
  state: TwoFingerGestureState,
  remainingTouchCount: number,
  inverted: boolean
): WheelMomentum | null {
  if (state.phase !== "active" || remainingTouchCount !== 0 || state.samples.length < 2) {
    return null;
  }
  const first = state.samples[0];
  const last = state.samples[state.samples.length - 1];
  const elapsed = last.timeStamp - first.timeStamp;
  if (elapsed <= 0) {
    return null;
  }
  return {
    velocity: ((first.clientY - last.clientY) / elapsed) * direction(inverted),
    point: state.last
  };
}

export function stepWheelMomentum(
  velocity: number,
  elapsedMs: number
): { deltaY: number; velocity: number; elapsedMs: number } {
  const boundedElapsed = Math.min(Math.max(elapsedMs, 0), MAX_MOMENTUM_FRAME_MS);
  return {
    deltaY: velocity * boundedElapsed,
    velocity:
      velocity *
      Math.pow(MOMENTUM_FRICTION_PER_FRAME, boundedElapsed / 16),
    elapsedMs: boundedElapsed
  };
}

export function isWheelMomentumActive(velocity: number): boolean {
  return Math.abs(velocity) >= MIN_MOMENTUM_VELOCITY;
}
```

- [ ] **Step 4: Run the pure tests**

Run:

```bash
bun test tests/two-finger-wheel-gesture.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the pure gesture unit**

```bash
git add src/web/components/twoFingerWheelGesture.ts tests/two-finger-wheel-gesture.test.ts
git commit -m "feat(web): add two-finger wheel gesture model

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: DOM adapter and coordinate-bearing wheel dispatch

**Files:**
- Create: `tests/terminal-touch-wheel.test.ts`
- Create: `src/web/components/terminalTouchWheel.ts`

- [ ] **Step 1: Write failing adapter tests**

Create `tests/terminal-touch-wheel.test.ts` with fakes for the event target and animation scheduler:

```ts
import { describe, expect, test } from "bun:test";
import {
  dispatchTerminalWheel,
  installTerminalTouchWheel,
  type AnimationScheduler
} from "../src/web/components/terminalTouchWheel.js";

describe("dispatchTerminalWheel", () => {
  test("dispatches pixel wheel input with terminal coordinates", () => {
    const events: Array<{ type: string; init: WheelEventInit }> = [];
    const target = { dispatchEvent: () => true };

    const dispatched = dispatchTerminalWheel(
      target,
      24,
      { clientX: 30, clientY: 40, screenX: 130, screenY: 240 },
      (type, init) => {
        events.push({ type, init });
        return new Event(type);
      }
    );

    expect(dispatched).toBe(true);
    expect(events).toEqual([{
      type: "wheel",
      init: {
        deltaY: 24,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
        clientX: 30,
        clientY: 40,
        screenX: 130,
        screenY: 240
      }
    }]);
  });

  test("does nothing for a missing target or zero delta", () => {
    expect(dispatchTerminalWheel(null, 1, null)).toBe(false);
    expect(dispatchTerminalWheel({ dispatchEvent: () => true }, 0, null)).toBe(false);
  });
});

describe("installTerminalTouchWheel", () => {
  test("leaves one-finger input untouched and owns two-finger movement", () => {
    const listeners = new Map<string, EventListener>();
    const container = {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
        listeners.set(type, listener as EventListener),
      removeEventListener: () => {}
    } as unknown as HTMLElement;
    const deltas: number[] = [];
    const scheduler: AnimationScheduler = {
      request: () => 1,
      cancel: () => {}
    };
    installTerminalTouchWheel({
      container,
      getTarget: () => ({ dispatchEvent: (event: Event) => {
        deltas.push((event as WheelEvent).deltaY);
        return true;
      }}),
      getInverted: () => false,
      scheduler,
      createEvent: (_type, init) => ({ ...init } as Event)
    });

    expect(listeners.has("touchstart")).toBe(true);
    expect(listeners.has("touchmove")).toBe(true);
    expect(listeners.has("touchend")).toBe(true);
    expect(listeners.has("touchcancel")).toBe(true);
    expect(deltas).toEqual([]);
  });
});
```

Add these helpers above the adapter `describe` block:

```ts
function makeTouchEvent(points: Array<{ x: number; y: number }>, timeStamp: number) {
  let defaultPrevented = false;
  let propagationStopped = false;
  return {
    touches: points.map(({ x, y }) => ({
      clientX: x,
      clientY: y,
      screenX: x + 100,
      screenY: y + 200
    })),
    timeStamp,
    preventDefault: () => {
      defaultPrevented = true;
    },
    stopPropagation: () => {
      propagationStopped = true;
    },
    get defaultPrevented() {
      return defaultPrevented;
    },
    get propagationStopped() {
      return propagationStopped;
    }
  } as unknown as TouchEvent & {
    readonly propagationStopped: boolean;
  };
}
```

Replace the adapter test body with a reusable setup and these exact assertions:

```ts
test("emits wheel deltas only after vertical two-finger intent", () => {
  const listeners = new Map<string, EventListener>();
  const deltas: number[] = [];
  const container = {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      listeners.set(type, listener as EventListener),
    removeEventListener: () => {}
  } as unknown as HTMLElement;

  installTerminalTouchWheel({
    container,
    getTarget: () => ({
      dispatchEvent: (event: Event) => {
        deltas.push((event as unknown as WheelEventInit).deltaY ?? 0);
        return true;
      }
    }),
    getInverted: () => false,
    scheduler: { request: () => 1, cancel: () => {} },
    createEvent: (_type, init) => ({ ...init } as Event)
  });

  const oneFinger = makeTouchEvent([{ x: 10, y: 100 }], 0);
  listeners.get("touchstart")?.(oneFinger);
  expect(oneFinger.defaultPrevented).toBe(false);

  listeners.get("touchstart")?.(
    makeTouchEvent([{ x: 0, y: 100 }, { x: 20, y: 100 }], 0)
  );
  const move = makeTouchEvent([{ x: 0, y: 80 }, { x: 20, y: 80 }], 20);
  listeners.get("touchmove")?.(move);

  expect(move.defaultPrevented).toBe(true);
  expect(move.propagationStopped).toBe(true);
  expect(deltas).toEqual([20]);
});

test("runs decaying momentum and cleanup cancels the pending frame", () => {
  const listeners = new Map<string, EventListener>();
  const removed: string[] = [];
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  const deltas: number[] = [];
  let nextId = 1;
  const container = {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      listeners.set(type, listener as EventListener),
    removeEventListener: (type: string) => removed.push(type)
  } as unknown as HTMLElement;
  const scheduler: AnimationScheduler = {
    request: (callback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancel: (id) => cancelled.push(id)
  };

  const dispose = installTerminalTouchWheel({
    container,
    getTarget: () => ({
      dispatchEvent: (event: Event) => {
        deltas.push((event as unknown as WheelEventInit).deltaY ?? 0);
        return true;
      }
    }),
    getInverted: () => false,
    scheduler,
    createEvent: (_type, init) => ({ ...init } as Event)
  });

  listeners.get("touchstart")?.(
    makeTouchEvent([{ x: 0, y: 100 }, { x: 20, y: 100 }], 0)
  );
  listeners.get("touchmove")?.(
    makeTouchEvent([{ x: 0, y: 80 }, { x: 20, y: 80 }], 20)
  );
  listeners.get("touchmove")?.(
    makeTouchEvent([{ x: 0, y: 60 }, { x: 20, y: 60 }], 40)
  );
  listeners.get("touchend")?.(makeTouchEvent([], 40));

  const firstFrame = callbacks.get(1);
  expect(firstFrame).toBeDefined();
  firstFrame?.(56);
  const secondFrame = callbacks.get(2);
  secondFrame?.(72);

  expect(deltas.length).toBeGreaterThan(2);
  expect(Math.abs(deltas.at(-1)!)).toBeLessThan(Math.abs(deltas.at(-2)!));

  dispose();
  expect(new Set(removed)).toEqual(
    new Set(["touchstart", "touchmove", "touchend", "touchcancel"])
  );
  expect(cancelled.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the adapter tests to verify they fail**

Run:

```bash
bun test tests/terminal-touch-wheel.test.ts
```

Expected: FAIL because `src/web/components/terminalTouchWheel.ts` does not exist.

- [ ] **Step 3: Implement the adapter**

Create `src/web/components/terminalTouchWheel.ts`. Use these public interfaces:

```ts
import {
  beginTwoFingerGesture,
  finishTwoFingerGesture,
  isWheelMomentumActive,
  moveTwoFingerGesture,
  stepWheelMomentum,
  type GesturePoint,
  type GestureTouch,
  type TwoFingerGestureState
} from "./twoFingerWheelGesture.js";

interface WheelDispatchTarget {
  dispatchEvent(event: Event): boolean;
}

export interface AnimationScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
}

interface InstallOptions {
  container: HTMLElement;
  getTarget: () => WheelDispatchTarget | null;
  getInverted: () => boolean;
  scheduler?: AnimationScheduler;
  createEvent?: (type: string, init: WheelEventInit) => Event;
}
```

Implement `dispatchTerminalWheel()` with an injectable event factory:

```ts
export function dispatchTerminalWheel(
  target: WheelDispatchTarget | null,
  deltaY: number,
  point: GesturePoint | null,
  createEvent: (type: string, init: WheelEventInit) => Event = (type, init) =>
    new WheelEvent(type, init)
): boolean {
  if (!target || !point || !Number.isFinite(deltaY) || deltaY === 0) {
    return false;
  }
  return target.dispatchEvent(
    createEvent("wheel", {
      deltaY,
      deltaMode: 0,
      bubbles: true,
      cancelable: true,
      clientX: point.clientX,
      clientY: point.clientY,
      screenX: point.screenX,
      screenY: point.screenY
    })
  );
}
```

Implement `installTerminalTouchWheel()`:

```ts
const nativeScheduler: AnimationScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id)
};

function touchList(touches: TouchList): GestureTouch[] {
  return Array.from(touches, (touch) => ({
    clientX: touch.clientX,
    clientY: touch.clientY,
    screenX: touch.screenX,
    screenY: touch.screenY
  }));
}

export function installTerminalTouchWheel(options: InstallOptions): () => void {
  const scheduler = options.scheduler ?? nativeScheduler;
  let state: TwoFingerGestureState = { phase: "idle" };
  let frameId: number | null = null;
  let lastFrameTime = 0;

  const cancelMomentum = (): void => {
    if (frameId !== null) {
      scheduler.cancel(frameId);
      frameId = null;
    }
    lastFrameTime = 0;
  };

  const dispatch = (deltaY: number, point: GesturePoint): void => {
    dispatchTerminalWheel(
      options.getTarget(),
      deltaY,
      point,
      options.createEvent
    );
  };

  const startMomentum = (velocity: number, point: GesturePoint): void => {
    const tick = (now: number): void => {
      const elapsed = lastFrameTime === 0 ? 16 : now - lastFrameTime;
      lastFrameTime = now;
      const step = stepWheelMomentum(velocity, elapsed);
      velocity = step.velocity;
      dispatch(step.deltaY, point);
      if (isWheelMomentumActive(velocity)) {
        frameId = scheduler.request(tick);
      } else {
        frameId = null;
        lastFrameTime = 0;
      }
    };
    frameId = scheduler.request(tick);
  };

  const onTouchStart = (event: TouchEvent): void => {
    cancelMomentum();
    state = beginTwoFingerGesture(touchList(event.touches), event.timeStamp);
    if (state.phase === "pending") {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onTouchMove = (event: TouchEvent): void => {
    const move = moveTwoFingerGesture(
      state,
      touchList(event.touches),
      event.timeStamp,
      options.getInverted()
    );
    state = move.state;
    if (!move.claimed) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (move.point && move.deltaY !== 0) {
      dispatch(move.deltaY, move.point);
    }
  };

  const onTouchEnd = (event: TouchEvent): void => {
    const momentum = finishTwoFingerGesture(
      state,
      event.touches.length,
      options.getInverted()
    );
    state = { phase: "idle" };
    if (momentum && isWheelMomentumActive(momentum.velocity)) {
      startMomentum(momentum.velocity, momentum.point);
    }
  };

  const onTouchCancel = (): void => {
    state = { phase: "idle" };
    cancelMomentum();
  };

  const listenerOptions = { capture: true, passive: false } as const;
  options.container.addEventListener("touchstart", onTouchStart, listenerOptions);
  options.container.addEventListener("touchmove", onTouchMove, listenerOptions);
  options.container.addEventListener("touchend", onTouchEnd, listenerOptions);
  options.container.addEventListener("touchcancel", onTouchCancel, listenerOptions);

  return () => {
    options.container.removeEventListener("touchstart", onTouchStart, true);
    options.container.removeEventListener("touchmove", onTouchMove, true);
    options.container.removeEventListener("touchend", onTouchEnd, true);
    options.container.removeEventListener("touchcancel", onTouchCancel, true);
    state = { phase: "idle" };
    cancelMomentum();
  };
}
```

Use `event.timeStamp` for gesture samples. Do not add a broad `try/catch`.

- [ ] **Step 4: Run adapter and pure tests**

Run:

```bash
bun test tests/two-finger-wheel-gesture.test.ts tests/terminal-touch-wheel.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the DOM adapter**

```bash
git add src/web/components/terminalTouchWheel.ts tests/terminal-touch-wheel.test.ts
git commit -m "feat(web): translate two-finger touch into wheel input

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Install the adapter in `TerminalView`

**Files:**
- Modify: `src/web/components/TerminalView.tsx`
- Modify: `tests/terminal-view.test.ts`

- [ ] **Step 1: Add failing TerminalView wiring assertions**

In `tests/terminal-view.test.ts`, add:

```ts
test("installs two-finger wheel handling without replacing the existing wheel policy", () => {
  const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

  expect(source).toContain("installTerminalTouchWheel({");
  expect(source).toContain("getTarget: () => term.element");
  expect(source).toContain("getInverted: () => touchWheelInvertedRef.current");
  expect(source).toContain("const disposeTouchWheel = installTerminalTouchWheel");
  expect(source).toContain("disposeTouchWheel();");
  expect(source).toContain("term.attachCustomWheelEventHandler((event) => {");
  expect(source).toContain("shouldHandleWheelAsScrollback({");
});

test("accepts the shared two-finger inversion preference", () => {
  const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

  expect(source).toContain("touchWheelInverted: boolean;");
  expect(source).toContain("const touchWheelInvertedRef = useRef(touchWheelInverted);");
  expect(source).toContain("touchWheelInvertedRef.current = touchWheelInverted;");
});
```

Update the existing server-rendered `TerminalView` test props with:

```ts
touchWheelInverted: false,
```

- [ ] **Step 2: Run the TerminalView test to verify failure**

Run:

```bash
bun test tests/terminal-view.test.ts
```

Expected: FAIL on the new source assertions and missing required prop.

- [ ] **Step 3: Wire the adapter into `TerminalView`**

Add:

```ts
import { installTerminalTouchWheel } from "./terminalTouchWheel.js";
```

Add to `Props`:

```ts
touchWheelInverted: boolean;
```

Destructure the prop, create a ref beside the existing current-prop refs, and
keep it current:

```ts
const touchWheelInvertedRef = useRef(touchWheelInverted);

useEffect(() => {
  touchWheelInvertedRef.current = touchWheelInverted;
}, [touchWheelInverted]);
```

Immediately after `term.open(container)` and ref assignment, install:

```ts
const disposeTouchWheel = installTerminalTouchWheel({
  container,
  getTarget: () => term.element,
  getInverted: () => touchWheelInvertedRef.current
});
```

In the terminal-creation effect cleanup, call:

```ts
disposeTouchWheel();
```

before `term.dispose()`. Do not change `attachCustomWheelEventHandler`.

- [ ] **Step 4: Run focused terminal tests**

Run:

```bash
bun test tests/two-finger-wheel-gesture.test.ts tests/terminal-touch-wheel.test.ts tests/terminal-view.test.ts
```

Expected: PASS.

- [ ] **Step 5: Type-check the integration**

Run:

```bash
bun run typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit TerminalView integration**

```bash
git add src/web/components/TerminalView.tsx tests/terminal-view.test.ts
git commit -m "feat(web): install terminal two-finger wheel gesture

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Register the shared inversion config and regenerate parity fixtures

**Files:**
- Modify: `src/config-settings.ts`
- Modify: `rust/climon-config/src/config_settings.rs`
- Modify: `src/types.ts`
- Modify: `src/dashboard-preference-keys.ts`
- Modify: `tests/config-settings.test.ts`
- Modify: `tests/dashboard-preferences-server.test.ts`
- Regenerate: `fixtures/config/default-config.json`
- Regenerate: `fixtures/config/default-rendered.jsonc`
- Regenerate: `fixtures/config/settings-table.md`
- Regenerate: `fixtures/config/settings-help.txt`
- Regenerate: `fixtures/config/docs-section.md`
- Modify generated config documentation through `bun run docs:config`

- [ ] **Step 1: Write failing TypeScript registry tests**

Update the expected dashboard default in `tests/config-settings.test.ts`:

```ts
dashboard: {
  theme: "Default",
  keyBarPinned: true,
  stateIconNoMotion: false,
  touchWheelInverted: false
},
```

Replace the dashboard-writable registration test with:

```ts
test("dashboard preferences are registered and writable", () => {
  for (const key of [
    "dashboard.theme",
    "dashboard.keyBarPinned",
    "dashboard.stateIconNoMotion",
    "dashboard.touchWheelInverted"
  ]) {
    expect(findConfigSetting(key)?.dashboardWritable).toBe(true);
  }
});

test("dashboard.touchWheelInverted validates booleans", () => {
  const setting = findConfigSetting("dashboard.touchWheelInverted");
  expect(setting?.defaultValue).toBe(false);
  expect(setting?.scope).toEqual(["server", "browser"]);
  expect(() => setting?.validate?.(true)).not.toThrow();
  expect(() => setting?.validate?.("yes")).toThrow();
});
```

In `tests/dashboard-preferences-server.test.ts`, assert default collection and
valid persistence:

```ts
expect(prefs["dashboard.touchWheelInverted"]).toBe(false);

const result = applyDashboardPreference(
  config,
  "dashboard.touchWheelInverted",
  true
);
expect(result.ok).toBe(true);
expect(config.dashboard?.touchWheelInverted).toBe(true);
```

- [ ] **Step 2: Run registry tests to verify failure**

Run:

```bash
bun test tests/config-settings.test.ts tests/dashboard-preferences-server.test.ts
```

Expected: FAIL because the setting is not registered.

- [ ] **Step 3: Add the TypeScript setting and shared types**

In `src/config-settings.ts`, insert after `dashboard.keyBarPinned`:

```ts
{
  path: "dashboard.touchWheelInverted",
  type: "boolean",
  defaultValue: false,
  purpose:
    "When true, reverses only the dashboard terminal's synthetic two-finger wheel gesture. Physical mouse and trackpad wheel direction is unchanged.",
  scope: ["server", "browser"],
  acceptInput: true,
  dashboardWritable: true,
  validate: (value: unknown) => {
    if (typeof value !== "boolean") {
      throw new Error("dashboard.touchWheelInverted must be a boolean");
    }
  }
},
```

In `src/types.ts`, add to `DashboardConfig`:

```ts
/** Reverse only the dashboard terminal's synthetic two-finger wheel gesture. */
touchWheelInverted?: boolean;
```

In `src/dashboard-preference-keys.ts`, add:

```ts
export const PREF_TOUCH_WHEEL_INVERTED = "dashboard.touchWheelInverted";
```

- [ ] **Step 4: Mirror the registry entry in Rust**

In `rust/climon-config/src/config_settings.rs`, insert after
`dashboard.keyBarPinned`:

```rust
ConfigSetting::new(
    "dashboard.touchWheelInverted",
    Boolean,
    "When true, reverses only the dashboard terminal's synthetic two-finger wheel gesture. Physical mouse and trackpad wheel direction is unchanged.",
    vec![Server, Browser],
)
.default(Value::from(false))
.accept_input(),
```

Update the Rust test path list, accepted-key list, and default JSON object to
include `dashboard.touchWheelInverted: false`.

- [ ] **Step 5: Run registry tests before fixture generation**

Run:

```bash
bun test tests/config-settings.test.ts tests/dashboard-preferences-server.test.ts
cargo test --manifest-path rust/Cargo.toml -p climon-config config_settings
```

Expected: TypeScript registry tests PASS; Rust config-setting tests PASS.

- [ ] **Step 6: Regenerate fixtures and config docs**

Run:

```bash
bun scripts/gen-config-fixtures.ts
bun run docs:config
```

Expected: config fixtures and generated docs include
`dashboard.touchWheelInverted`.

- [ ] **Step 7: Run cross-language fixture tests**

Run:

```bash
bun test tests/config-fixtures.test.ts tests/config-docs.test.ts
cargo test --manifest-path rust/Cargo.toml -p climon-config fixtures
```

Expected: PASS.

- [ ] **Step 8: Commit config parity**

```bash
git add src/config-settings.ts src/types.ts src/dashboard-preference-keys.ts \
  rust/climon-config/src/config_settings.rs fixtures/config docs tests/config-settings.test.ts \
  tests/dashboard-preferences-server.test.ts
git commit -m "feat(config): add touch wheel inversion preference

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Hydrate, persist, and pass the preference in `App`

**Files:**
- Modify: `src/web/App.tsx`
- Modify: `tests/app-layout.test.ts`

- [ ] **Step 1: Add failing App wiring assertions**

In `tests/app-layout.test.ts`, add:

```ts
test("hydrates and passes the shared touch wheel inversion preference", () => {
  const source = readFileSync("src/web/App.tsx", "utf8");

  expect(source).toContain("PREF_TOUCH_WHEEL_INVERTED");
  expect(source).toContain("const [touchWheelInverted, setTouchWheelInverted]");
  expect(source).toContain("readCachedPreference(PREF_TOUCH_WHEEL_INVERTED) === true");
  expect(source).toContain("const serverTouchWheelInverted = preferences[PREF_TOUCH_WHEEL_INVERTED];");
  expect(source).toContain("setTouchWheelInverted(serverTouchWheelInverted);");
  expect(source).toContain("touchWheelInverted={touchWheelInverted}");
  expect(source).toContain("void setDashboardPreference(PREF_TOUCH_WHEEL_INVERTED, next);");
});
```

- [ ] **Step 2: Run the App test to verify failure**

Run:

```bash
bun test tests/app-layout.test.ts
```

Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement App state and persistence**

Import `PREF_TOUCH_WHEEL_INVERTED` with the existing preference constants.

Add state beside `keyBarPinned`:

```ts
const [touchWheelInverted, setTouchWheelInverted] = useState<boolean>(
  () => readCachedPreference(PREF_TOUCH_WHEEL_INVERTED) === true
);
```

Hydrate from `fetchHealth()`:

```ts
const serverTouchWheelInverted = preferences[PREF_TOUCH_WHEEL_INVERTED];
if (typeof serverTouchWheelInverted === "boolean") {
  setTouchWheelInverted(serverTouchWheelInverted);
}
```

Add the toggle callback:

```ts
const handleToggleTouchWheelInverted = useCallback((): void => {
  setTouchWheelInverted((prev) => {
    const next = !prev;
    void setDashboardPreference(PREF_TOUCH_WHEEL_INVERTED, next);
    return next;
  });
}, []);
```

Pass to `TerminalView`:

```tsx
touchWheelInverted={touchWheelInverted}
```

Pass the value, touch-primary capability, and callback to `Sidebar`:

```tsx
isTouchPrimary={isTouchPrimary}
touchWheelInverted={touchWheelInverted}
onToggleTouchWheelInverted={handleToggleTouchWheelInverted}
```

- [ ] **Step 4: Run App and terminal tests**

Run:

```bash
bun test tests/app-layout.test.ts tests/terminal-view.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit App preference wiring**

```bash
git add src/web/App.tsx tests/app-layout.test.ts
git commit -m "feat(web): wire shared touch wheel preference

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Add the touch-primary sidebar toggle

**Files:**
- Modify: `src/web/sidebar-utils.ts`
- Modify: `src/web/components/Sidebar.tsx`
- Modify: `tests/sidebar-menu.test.ts`

- [ ] **Step 1: Write failing label and visibility tests**

Import `touchWheelInversionMenuLabel` in `tests/sidebar-menu.test.ts` and add:

```ts
test("labels the two-finger inversion action", () => {
  expect(touchWheelInversionMenuLabel(false)).toBe("Invert two-finger scrolling");
  expect(touchWheelInversionMenuLabel(true)).toBe("Use natural two-finger scrolling");
});
```

Add these common props:

```ts
isTouchPrimary: false,
touchWheelInverted: false,
onToggleTouchWheelInverted: () => {},
```

Add:

```ts
test("shows two-finger inversion only on touch-primary devices", () => {
  const desktop = renderToStaticMarkup(
    createElement(Sidebar, { ...commonProps, isMobile: false, isTouchPrimary: false })
  );
  const wideTouch = renderToStaticMarkup(
    createElement(Sidebar, { ...commonProps, isMobile: false, isTouchPrimary: true })
  );

  expect(desktop).not.toContain("Invert two-finger scrolling");
  expect(wideTouch).toContain("Invert two-finger scrolling");
});
```

- [ ] **Step 2: Run the sidebar tests to verify failure**

Run:

```bash
bun test tests/sidebar-menu.test.ts
```

Expected: FAIL because the helper and props do not exist.

- [ ] **Step 3: Implement the label and menu item**

In `src/web/sidebar-utils.ts`, add:

```ts
export function touchWheelInversionMenuLabel(inverted: boolean): string {
  return inverted
    ? "Use natural two-finger scrolling"
    : "Invert two-finger scrolling";
}
```

Import it in `Sidebar.tsx`. Add props:

```ts
isTouchPrimary: boolean;
touchWheelInverted: boolean;
onToggleTouchWheelInverted: () => void;
```

Destructure those props, then add immediately after the key-bar item:

```tsx
{isTouchPrimary && (
  <MenuItem onClick={onToggleTouchWheelInverted}>
    {touchWheelInversionMenuLabel(touchWheelInverted)}
  </MenuItem>
)}
```

Keep **Pin key bar** gated by `isMobile`; only the inversion setting uses
`isTouchPrimary`.

- [ ] **Step 4: Run sidebar and App tests**

Run:

```bash
bun test tests/sidebar-menu.test.ts tests/app-layout.test.ts
```

Expected: PASS.

- [ ] **Step 5: Type-check the complete UI**

Run:

```bash
bun run typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit the sidebar toggle**

```bash
git add src/web/sidebar-utils.ts src/web/components/Sidebar.tsx tests/sidebar-menu.test.ts
git commit -m "feat(web): expose touch wheel inversion toggle

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: User documentation, manual checks, and feature catalogue

**Files:**
- Create: `docs/manual-tests/two-finger-terminal-wheel.md`
- Modify: `docs/manual-tests/README.md`
- Modify: `docs/usage.md`
- Modify: `docs/features.md`

- [ ] **Step 1: Add the manual-test document**

Create `docs/manual-tests/two-finger-terminal-wheel.md`:

```md
# Two-finger terminal wheel gesture

Manual checks for terminal-local two-finger wheel forwarding, release momentum,
and the shared inversion preference.

## TFW-1 — Normal output scrollback

- **Feature:** Two-finger terminal wheel gesture
- **Preconditions:** Touch device/PWA; live session with more than one screen of
  normal-buffer output; `dashboard.touchWheelInverted = false`.
- **Config-matrix cell:** Browser = iOS Safari or Android Chrome; natural direction.
- **Steps:**
  1. Place two fingers over the terminal and move them down.
  2. Move both fingers up.
- **Expected result:** Moving down reveals older output; moving up returns toward
  newer output. The page itself does not move or refresh.
- **Platforms:** iOS Safari/PWA, Android Chrome/PWA.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFW-2 — Mouse-aware TUI receives wheel input

- **Feature:** Two-finger terminal wheel gesture
- **Preconditions:** Touch device; run a mouse-aware full-screen TUI such as
  `less`, `vim`, or `htop`.
- **Config-matrix cell:** Browser = touch; TUI mouse tracking = active.
- **Steps:**
  1. Confirm the TUI responds to a physical wheel when available.
  2. Swipe vertically with two fingers over the terminal.
- **Expected result:** The TUI scrolls internally; browser-side terminal history
  is not substituted for the app's mouse handling.
- **Platforms:** iOS Safari/PWA, Android Chrome/PWA.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFW-3 — One-finger behavior is unchanged

- **Feature:** One-finger regression
- **Preconditions:** Touch device; normal terminal output and an interactive prompt.
- **Config-matrix cell:** Browser = touch.
- **Steps:**
  1. Tap and drag with one finger as before the feature.
  2. Tap the terminal to focus it and enter text.
- **Expected result:** One-finger behavior remains xterm/browser-native; no
  synthetic two-finger wheel input or duplicate scrolling occurs.
- **Platforms:** iOS Safari/PWA, Android Chrome/PWA.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFW-4 — Non-vertical gestures are rejected

- **Feature:** Gesture intent filtering
- **Preconditions:** Touch device; stationary terminal content.
- **Config-matrix cell:** Browser = touch.
- **Steps:**
  1. Move two fingers horizontally.
  2. Perform a diagonal movement whose horizontal distance is greater.
  3. Pinch inward and outward.
  4. Repeat with one finger and with three fingers.
- **Expected result:** None of these gestures emits terminal wheel input.
- **Platforms:** iOS Safari/PWA, Android Chrome/PWA.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFW-5 — Momentum decays and grab-to-stop works

- **Feature:** Gesture momentum
- **Preconditions:** Touch device; long scrollable output.
- **Config-matrix cell:** Browser = touch.
- **Steps:**
  1. Make a quick vertical two-finger swipe and release both fingers together.
  2. Observe continued movement.
  3. Touch the terminal again while momentum is active.
- **Expected result:** Scrolling continues briefly, slows smoothly, and stops
  immediately on the new touch without a jump.
- **Platforms:** iOS Safari/PWA, Android Chrome/PWA.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFW-6 — Inversion affects only the synthetic gesture

- **Feature:** `dashboard.touchWheelInverted`
- **Preconditions:** Touch-primary device with a physical wheel/trackpad available,
  or repeat the physical-wheel check on a desktop browser.
- **Config-matrix cell:** Preference = false then true.
- **Steps:**
  1. Record two-finger and physical-wheel directions with the preference false.
  2. Choose **Invert two-finger scrolling**.
  3. Repeat both inputs.
- **Expected result:** Only the two-finger gesture reverses. Physical wheel and
  trackpad direction is unchanged; the menu reads **Use natural two-finger scrolling**.
- **Platforms:** Touch laptop/tablet plus desktop Chrome/Safari/Edge.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFW-7 — Preference persists and is shared

- **Feature:** Shared dashboard preference
- **Preconditions:** Two browsers/devices connected to the same dashboard.
- **Config-matrix cell:** Local and Tunnel Link viewers.
- **Steps:**
  1. Enable inversion in the first browser and reload it.
  2. Open or reload the second browser.
  3. Inspect `$CLIMON_HOME/config.jsonc`.
- **Expected result:** Both browsers show the inverted label/direction and config
  contains `dashboard.touchWheelInverted: true`.
- **Platforms:** Any two supported browsers/devices.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFW-8 — Menu visibility follows touch capability

- **Feature:** Touch-primary preference UI
- **Preconditions:** Narrow phone, wide touch tablet/laptop, and non-touch desktop.
- **Config-matrix cell:** touch-primary true/false; viewport narrow/wide.
- **Steps:**
  1. Open the hamburger menu on each device/layout.
- **Expected result:** The inversion item appears on both touch-primary layouts
  and is absent on the non-touch desktop. **Pin key bar** retains its existing
  narrow-mobile visibility.
- **Platforms:** iOS/Android, touch Windows device, desktop browser.
- **Result:** _date / tester / platform / pass-fail / notes_

## TFW-9 — Cancellation does not leak input

- **Feature:** Gesture cancellation
- **Preconditions:** Touch device; long scrollable output.
- **Config-matrix cell:** Browser = touch.
- **Steps:**
  1. Start a two-finger vertical gesture, then lift only one finger.
  2. Start again and add a third finger.
  3. Start again and background the app/browser before release.
- **Expected result:** Input stops without momentum, a delayed jump, or continued
  wheel events after returning to the app.
- **Platforms:** iOS Safari/PWA, Android Chrome/PWA.
- **Result:** _date / tester / platform / pass-fail / notes_
```

- [ ] **Step 2: Index the manual checks**

Add to `docs/manual-tests/README.md`:

```md
| — | Two-finger terminal wheel gesture — TUI forwarding, momentum, inversion preference | [two-finger-terminal-wheel.md](two-finger-terminal-wheel.md) |
```

- [ ] **Step 3: Update usage documentation**

Replace the inaccurate one-finger mouse-wheel claim in `docs/usage.md` with:

```md
  - On touch devices, a vertical **two-finger swipe** over the terminal follows
    mouse-wheel semantics: normal output moves through terminal scrollback, while
    mouse-aware apps receive wheel input. One-finger touch behavior remains
    xterm/browser-native. The gesture has release momentum.
```

Extend the menu-preferences paragraph with:

```md
The touch-primary menu also offers **Invert two-finger scrolling**, stored as
`dashboard.touchWheelInverted`; it reverses only the synthetic touch gesture,
not a physical mouse or trackpad wheel.
```

Add the corresponding `climon config dashboard.touchWheelInverted <bool>`
example where the existing dashboard preference CLI examples are listed.

- [ ] **Step 4: Update the feature catalogue**

In `docs/features.md`:

- expand `dash-05` to list `dashboard.touchWheelInverted` among shared
  preferences; and
- replace the abandoned `dash-20` edge-wheel row with the implemented
  two-finger gesture description and manual-test/source links, retaining
  **in-development** status because this branch is not merged to `main`.

Use this factual row:

```md
| dash-20 | Two-finger terminal wheel gesture | A vertically intentional two-finger swipe over xterm emits coordinate-bearing wheel input with bounded release momentum; normal output uses local scrollback, mouse-aware TUIs receive xterm mouse reporting, and `dashboard.touchWheelInverted` reverses only this gesture. | Drive scrollable terminal apps naturally from a phone or tablet without changing one-finger touch or physical wheel behaviour. | [manual-tests/two-finger-terminal-wheel.md](manual-tests/two-finger-terminal-wheel.md); `src/web/components/twoFingerWheelGesture.ts`, `terminalTouchWheel.ts`, `TerminalView.tsx`; **branch `two-finger-wheel-gesture`** |
```

- [ ] **Step 5: Check documentation consistency**

Run:

```bash
rg -n "one-finger swipe|terminal-scroll-wheel|touchWheelInverted|two-finger" docs/usage.md docs/features.md docs/manual-tests
git diff --check
```

Expected: the old one-finger mouse-wheel claim and abandoned edge-wheel feature
description are gone; the new setting and manual-test link are present.

- [ ] **Step 6: Commit documentation**

```bash
git add docs/usage.md docs/features.md docs/manual-tests
git commit -m "docs: document two-finger terminal wheel gesture

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Complete verification

**Files:**
- Verify all changed files

- [ ] **Step 1: Format changed code**

Run:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
```

If the check reports formatting differences, run:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all
```

Then rerun the check. Expected: PASS.

- [ ] **Step 2: Run all focused Bun tests**

Run:

```bash
bun test \
  tests/two-finger-wheel-gesture.test.ts \
  tests/terminal-touch-wheel.test.ts \
  tests/terminal-view.test.ts \
  tests/config-settings.test.ts \
  tests/config-fixtures.test.ts \
  tests/config-docs.test.ts \
  tests/dashboard-preferences-server.test.ts \
  tests/app-layout.test.ts \
  tests/sidebar-menu.test.ts
```

Expected: PASS with zero failures.

- [ ] **Step 3: Run TypeScript lint/type-check**

Run:

```bash
bun run lint
```

Expected: PASS.

- [ ] **Step 4: Run Rust config parity tests**

Run:

```bash
cargo test --manifest-path rust/Cargo.toml -p climon-config
```

Expected: PASS.

- [ ] **Step 5: Build the web bundle**

Run:

```bash
bun run build:web
```

Expected: PASS and generated dashboard assets build successfully.

- [ ] **Step 6: Run the full Bun suite**

Run:

```bash
bun test tests
```

Expected: PASS with zero failures.

- [ ] **Step 7: Inspect the final change set**

Run:

```bash
git status --short
git diff --check
git --no-pager diff dev...HEAD --stat
git --no-pager log --oneline dev..HEAD
```

Expected: only gesture, preference, config-parity, test, and documentation files
are changed; no generated dependency or temporary files are present.
