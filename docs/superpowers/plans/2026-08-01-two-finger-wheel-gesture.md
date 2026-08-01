# Two-Finger Terminal Wheel Gesture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an exact-two-finger vertical terminal gesture that follows xterm's physical-wheel path and stops when the fingers are released.

**Architecture:** A pure `twoFingerWheelGesture.ts` module owns midpoint and intent calculations. A DOM-focused `terminalTouchWheel.ts` adapter owns capture-phase touch listeners and coordinate-bearing synthetic `WheelEvent` dispatch; `TerminalView` installs it and retains the existing local-scrollback versus TUI-forwarding policy. The direction toggle uses the existing dashboard-writable preference mechanism.

**Tech Stack:** TypeScript ESM, React 19, `@xterm/xterm` 6, Fluent UI v9, Bun tests, Rust config-registry parity.

**Spec:** `docs/superpowers/specs/2026-08-01-two-finger-wheel-gesture-design.md`

---

## File Structure

- **Create** `src/web/components/twoFingerWheelGesture.ts` — pure midpoint, intent, rejection, and direct-delta calculations.
- **Create** `src/web/components/terminalTouchWheel.ts` — terminal-local touch listeners and synthetic wheel dispatch.
- **Create** `tests/two-finger-wheel-gesture.test.ts` — pure gesture tests.
- **Create** `tests/terminal-touch-wheel.test.ts` — DOM adapter tests.
- **Modify** `src/web/components/TerminalView.tsx` — install the adapter beside the existing wheel policy.
- **Modify** `tests/terminal-view.test.ts` — assert adapter wiring and wheel routing.
- **Modify** `src/config-settings.ts` — register `dashboard.touchWheelInverted`.
- **Modify** `rust/climon-config/src/config_settings.rs` — mirror the setting.
- **Modify** `src/types.ts` — add the dashboard config field.
- **Modify** `src/dashboard-preference-keys.ts` — add the shared key.
- **Modify** `src/web/App.tsx` — cache, hydrate, persist, and pass the setting.
- **Modify** `src/web/sidebar-utils.ts` — expose the menu label helper.
- **Modify** `src/web/components/Sidebar.tsx` — add the touch-primary toggle.
- **Modify** config, preference, App, and Sidebar tests.
- **Regenerate** config fixtures and generated config documentation.
- **Modify** user, feature-catalogue, and manual-test documentation.

---

### Task 1: Implement pure gesture recognition

**Files:**
- Create: `tests/two-finger-wheel-gesture.test.ts`
- Create: `src/web/components/twoFingerWheelGesture.ts`

- [ ] **Step 1: Write failing tests**

Cover:

```ts
test("arms only on exactly two touches and uses the midpoint", () => {});
test("jitter below 8px remains pending", () => {});
test("vertical movement activates and emits an incremental delta", () => {});
test("horizontal movement is rejected", () => {});
test("an 8px span change is rejected as pinch input", () => {});
test("inversion reverses only the emitted delta", () => {});
test("touch-count changes cancel to idle", () => {});
```

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
bun test tests/two-finger-wheel-gesture.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure state machine**

Use these public types and functions:

```ts
export type GestureTouch = {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
};

export type GesturePoint = GestureTouch & {
  timeStamp: number;
};

export type TwoFingerGestureState =
  | { phase: "idle" }
  | { phase: "rejected"; point: GesturePoint; initialSpan: number }
  | {
      phase: "pending" | "active";
      anchor: GesturePoint;
      point: GesturePoint;
      initialSpan: number;
    };

export function beginTwoFingerGesture(
  touches: readonly GestureTouch[],
  timeStamp: number
): TwoFingerGestureState;

export function moveTwoFingerGesture(
  state: TwoFingerGestureState,
  touches: readonly GestureTouch[],
  timeStamp: number,
  inverted: boolean
): {
  state: TwoFingerGestureState;
  claimed: boolean;
  deltaY: number;
  point?: GesturePoint;
};
```

Use an 8px activation threshold, 8px pinch rejection threshold, and 1.25
vertical-dominance ratio.

- [ ] **Step 4: Verify the tests pass**

Run:

```bash
bun test tests/two-finger-wheel-gesture.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/twoFingerWheelGesture.ts tests/two-finger-wheel-gesture.test.ts
git commit -m "feat(web): add two-finger wheel gesture model"
```

---

### Task 2: Implement the terminal touch adapter

**Files:**
- Create: `tests/terminal-touch-wheel.test.ts`
- Create: `src/web/components/terminalTouchWheel.ts`

- [ ] **Step 1: Write failing adapter tests**

Cover:

```ts
test("dispatches a pixel wheel event at the midpoint", () => {});
test("one-finger starts remain untouched", () => {});
test("vertical moves are claimed and dispatch direct deltas", () => {});
test("inversion reverses direct deltas", () => {});
test("horizontal and pinch input dispatch no wheel delta", () => {});
test("release emits no additional wheel event", () => {});
test("disposal removes every listener", () => {});
```

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
bun test tests/terminal-touch-wheel.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement event dispatch**

Expose:

```ts
export type TerminalTouchWheelOptions = {
  container: HTMLElement;
  getTarget(): { dispatchEvent(event: Event): boolean } | null;
  getInverted(): boolean;
  createEvent?: (type: string, init: WheelEventInit) => Event;
};

export function installTerminalTouchWheel(
  options: TerminalTouchWheelOptions
): () => void;
```

Install `touchstart`, `touchmove`, `touchend`, and `touchcancel` with
`{ capture: true, passive: false }`. Dispatch accepted direct deltas as
coordinate-bearing pixel wheel events. Reset state on end or cancellation.

- [ ] **Step 4: Verify the tests pass**

Run:

```bash
bun test tests/terminal-touch-wheel.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/terminalTouchWheel.ts tests/terminal-touch-wheel.test.ts
git commit -m "feat(web): translate two-finger touch into wheel input"
```

---

### Task 3: Wire xterm and preserve wheel policy

**Files:**
- Modify: `src/web/components/TerminalView.tsx`
- Modify: `tests/terminal-view.test.ts`

- [ ] **Step 1: Add failing wiring tests**

Assert that the adapter:

- is installed after `term.open(container)`;
- targets `term.element`;
- reads inversion through a current ref; and
- is disposed before `term.dispose()`.

Retain tests proving local scrollback is handled in normal mode and xterm keeps
control when mouse tracking is enabled or no normal-buffer scrollback exists.

- [ ] **Step 2: Verify failure**

Run:

```bash
bun test tests/terminal-view.test.ts
```

Expected: FAIL because the adapter is not installed.

- [ ] **Step 3: Install the adapter**

Pass:

```ts
{
  container,
  getTarget: () => term.element ?? null,
  getInverted: () => touchWheelInvertedRef.current
}
```

Do not add a separate wheel-routing path.

- [ ] **Step 4: Verify pass**

Run:

```bash
bun test tests/terminal-view.test.ts tests/terminal-touch-wheel.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/TerminalView.tsx tests/terminal-view.test.ts
git commit -m "feat(web): install terminal two-finger wheel gesture"
```

---

### Task 4: Add the shared inversion preference

**Files:**
- Modify: `src/config-settings.ts`
- Modify: `rust/climon-config/src/config_settings.rs`
- Modify: `src/types.ts`
- Modify: `src/dashboard-preference-keys.ts`
- Modify: `tests/config-settings.test.ts`
- Modify: `tests/dashboard-preferences-server.test.ts`
- Regenerate: `fixtures/config/*`
- Regenerate: generated config documentation

- [ ] **Step 1: Write failing registry and preference tests**

Require `dashboard.touchWheelInverted` to be:

- boolean;
- default `false`;
- server/browser scoped;
- accepted by CLI input;
- dashboard-writable; and
- represented identically by TypeScript and Rust registries.

- [ ] **Step 2: Verify failure**

Run:

```bash
bun test tests/config-settings.test.ts tests/dashboard-preferences-server.test.ts
cd rust && cargo test -p climon-config
```

- [ ] **Step 3: Implement both registries and shared types**

Add the key and optional config field, then register and validate the setting in
both languages.

- [ ] **Step 4: Regenerate shared artifacts**

Run:

```bash
bun scripts/gen-config-fixtures.ts
bun run docs:config
```

- [ ] **Step 5: Verify parity**

Run:

```bash
bun test tests/config-settings.test.ts tests/dashboard-preferences-server.test.ts tests/config-fixtures.test.ts
cd rust && cargo test -p climon-config
```

- [ ] **Step 6: Commit**

```bash
git add src/config-settings.ts src/dashboard-preference-keys.ts src/types.ts rust/climon-config/src/config_settings.rs tests fixtures/config docs/usage.md
git commit -m "feat(config): add touch wheel inversion preference"
```

---

### Task 5: Wire App and Sidebar

**Files:**
- Modify: `src/web/App.tsx`
- Modify: `src/web/sidebar-utils.ts`
- Modify: `src/web/components/Sidebar.tsx`
- Modify: `tests/app-layout.test.ts`
- Modify: `tests/sidebar-menu.test.ts`

- [ ] **Step 1: Add failing UI wiring tests**

Cover:

- cached initialization;
- server hydration;
- immediate persistence;
- passing the value to `TerminalView`;
- touch-primary-only menu visibility; and
- inversion label changes.

- [ ] **Step 2: Verify failure**

Run:

```bash
bun test tests/app-layout.test.ts tests/sidebar-menu.test.ts
```

- [ ] **Step 3: Implement state and menu wiring**

Initialize from `readCachedPreference`, hydrate from server health, persist via
`setDashboardPreference`, and pass the current value to `Sidebar` and
`TerminalView`.

- [ ] **Step 4: Verify pass**

Run:

```bash
bun test tests/app-layout.test.ts tests/sidebar-menu.test.ts tests/terminal-view.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/web/App.tsx src/web/sidebar-utils.ts src/web/components/Sidebar.tsx tests/app-layout.test.ts tests/sidebar-menu.test.ts
git commit -m "feat(web): expose touch wheel inversion toggle"
```

---

### Task 6: Update documentation and verify

**Files:**
- Modify: `docs/usage.md`
- Modify: `docs/features.md`
- Create: `docs/manual-tests/two-finger-terminal-wheel.md`
- Modify: `docs/manual-tests/README.md`

- [ ] **Step 1: Document final behavior**

Document:

- exact-two-finger vertical input;
- local scrollback and mouse-aware TUI routing;
- stop-on-release behavior;
- one-finger preservation;
- inversion setting and touch-primary menu; and
- shared preference persistence.

- [ ] **Step 2: Add manual checks**

Include cases for:

- natural direction;
- mouse-aware TUI forwarding;
- one-finger preservation;
- horizontal, diagonal, pinch, and wrong-count rejection;
- immediate stop on release;
- inversion independence from physical wheel input;
- preference persistence;
- touch-primary menu visibility; and
- touch-count / `touchcancel` interruption.

- [ ] **Step 3: Run focused verification**

```bash
bun test tests/two-finger-wheel-gesture.test.ts tests/terminal-touch-wheel.test.ts tests/terminal-view.test.ts tests/config-settings.test.ts tests/dashboard-preferences-server.test.ts tests/app-layout.test.ts tests/sidebar-menu.test.ts
cd rust && cargo test -p climon-config
bun run lint
bun run build:web
git diff --check
```

- [ ] **Step 4: Run the full Bun suite**

```bash
bun test tests
```

Expected: zero failures.

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "docs: document two-finger terminal wheel gesture"
```
