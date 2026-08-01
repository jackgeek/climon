import { describe, expect, test } from "bun:test";
import {
  dispatchTerminalWheel,
  installTerminalTouchWheel,
  type WheelDispatchTarget
} from "../src/web/components/terminalTouchWheel.js";

type Listener = (event: FakeTouchEvent) => void;

type ListenerRecord = {
  listener: Listener;
  options?: AddEventListenerOptions | boolean;
};

type FakeTouch = {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
};

type CapturedWheelEvent = Event & {
  type: string;
  init: WheelEventInit;
};

class FakeContainer {
  readonly listeners = new Map<string, ListenerRecord[]>();

  addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions | boolean): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, options });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener, options?: AddEventListenerOptions | boolean): void {
    const listeners = this.listeners.get(type) ?? [];
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    this.listeners.set(
      type,
      listeners.filter((record) => {
        const recordCapture =
          typeof record.options === "boolean" ? record.options : (record.options?.capture ?? false);
        return record.listener !== listener || recordCapture !== capture;
      })
    );
  }

  emit(type: string, event: FakeTouchEvent): void {
    for (const { listener } of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeTouchEvent {
  defaultPrevented = false;
  propagationStopped = false;

  constructor(
    readonly touches: FakeTouch[],
    readonly timeStamp: number
  ) {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

class FakeWheelTarget implements WheelDispatchTarget {
  readonly events: CapturedWheelEvent[] = [];

  dispatchEvent(event: Event): boolean {
    this.events.push(event as CapturedWheelEvent);
    return true;
  }
}

function touch(clientX: number, clientY: number, screenX = clientX + 100, screenY = clientY + 200): FakeTouch {
  return { clientX, clientY, screenX, screenY };
}

function createWheelEvent(type: string, init: WheelEventInit): Event {
  return { type, init } as CapturedWheelEvent;
}

function installHarness(options: { inverted?: boolean; target?: FakeWheelTarget | null } = {}) {
  const container = new FakeContainer();
  const target = options.target === undefined ? new FakeWheelTarget() : options.target;
  const dispose = installTerminalTouchWheel({
    container: container as unknown as HTMLElement,
    getTarget: () => target,
    getInverted: () => options.inverted ?? false,
    createEvent: createWheelEvent
  });

  return { container, target, dispose };
}

describe("terminal touch wheel adapter", () => {
  test("dispatches a pixel-mode wheel event at the gesture midpoint", () => {
    const target = new FakeWheelTarget();

    const dispatched = dispatchTerminalWheel(target, 12, {
      clientX: 10,
      clientY: 20,
      screenX: 30,
      screenY: 40,
      timeStamp: 50
    }, createWheelEvent);

    expect(dispatched).toBe(true);
    expect(target.events).toHaveLength(1);
    expect(target.events[0].type).toBe("wheel");
    expect(target.events[0].init).toMatchObject({
      bubbles: true,
      cancelable: true,
      deltaMode: 0,
      deltaY: 12,
      clientX: 10,
      clientY: 20,
      screenX: 30,
      screenY: 40
    });
  });

  test("dispatch returns false without a target, point, or nonzero finite delta", () => {
    const target = new FakeWheelTarget();
    const point = { clientX: 10, clientY: 20, screenX: 30, screenY: 40, timeStamp: 50 };

    expect(dispatchTerminalWheel(null, 1, point, createWheelEvent)).toBe(false);
    expect(dispatchTerminalWheel(target, 1, undefined, createWheelEvent)).toBe(false);
    expect(dispatchTerminalWheel(target, 0, point, createWheelEvent)).toBe(false);
    expect(dispatchTerminalWheel(target, Number.NaN, point, createWheelEvent)).toBe(false);
    expect(target.events).toHaveLength(0);
  });

  test("one-finger starts are left untouched", () => {
    const { container, target } = installHarness();
    const start = new FakeTouchEvent([touch(10, 20)], 0);

    container.emit("touchstart", start);

    expect(start.defaultPrevented).toBe(false);
    expect(start.propagationStopped).toBe(false);
    expect(target?.events).toHaveLength(0);
  });

  test("exact-two vertical moves are stopped and emit positive wheel deltas", () => {
    const { container, target } = installHarness();
    const start = new FakeTouchEvent([touch(10, 20), touch(30, 40)], 0);
    const move = new FakeTouchEvent([touch(10, 10), touch(30, 30)], 16);

    container.emit("touchstart", start);
    container.emit("touchmove", move);

    expect(start.defaultPrevented).toBe(true);
    expect(start.propagationStopped).toBe(true);
    expect(move.defaultPrevented).toBe(true);
    expect(move.propagationStopped).toBe(true);
    expect(target?.events.map((event) => event.init.deltaY)).toEqual([10]);
    expect(target?.events[0].init).toMatchObject({
      clientX: 20,
      clientY: 20,
      screenX: 120,
      screenY: 220
    });
  });

  test("inversion flips vertical wheel deltas", () => {
    const { container, target } = installHarness({ inverted: true });

    container.emit("touchstart", new FakeTouchEvent([touch(10, 20), touch(30, 40)], 0));
    container.emit("touchmove", new FakeTouchEvent([touch(10, 10), touch(30, 30)], 16));

    expect(target?.events.map((event) => event.init.deltaY)).toEqual([-10]);
  });

  test("horizontal and pinch gestures are claimed without dispatching deltas", () => {
    const horizontal = installHarness();
    const horizontalMove = new FakeTouchEvent([touch(30, 20), touch(50, 40)], 16);
    horizontal.container.emit("touchstart", new FakeTouchEvent([touch(10, 20), touch(30, 40)], 0));
    horizontal.container.emit("touchmove", horizontalMove);

    const pinch = installHarness();
    const pinchMove = new FakeTouchEvent([touch(0, 20), touch(40, 40)], 16);
    pinch.container.emit("touchstart", new FakeTouchEvent([touch(10, 20), touch(30, 40)], 0));
    pinch.container.emit("touchmove", pinchMove);

    expect(horizontalMove.defaultPrevented).toBe(true);
    expect(horizontalMove.propagationStopped).toBe(true);
    expect(horizontal.target?.events).toHaveLength(0);
    expect(pinchMove.defaultPrevented).toBe(true);
    expect(pinchMove.propagationStopped).toBe(true);
    expect(pinch.target?.events).toHaveLength(0);
  });

  test("touch count changes finish without another wheel event", () => {
    const { container, target } = installHarness();

    container.emit("touchstart", new FakeTouchEvent([touch(10, 20), touch(30, 40)], 0));
    container.emit("touchmove", new FakeTouchEvent([touch(10, 0), touch(30, 20)], 50));
    container.emit("touchend", new FakeTouchEvent([touch(10, 0)], 50));

    expect(target?.events.map((event) => event.init.deltaY)).toEqual([20]);
  });

  test("release stops scrolling without another wheel event", () => {
    const { container, target } = installHarness();

    container.emit("touchstart", new FakeTouchEvent([touch(10, 20), touch(30, 40)], 0));
    container.emit("touchmove", new FakeTouchEvent([touch(10, 0), touch(30, 20)], 50));
    container.emit("touchend", new FakeTouchEvent([], 50));

    expect(target?.events.map((event) => event.init.deltaY)).toEqual([20]);
  });

  test("disposer removes touch listeners", () => {
    const { container, dispose } = installHarness();

    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      expect(container.listeners.get(type)).toEqual([
        expect.objectContaining({ options: { capture: true, passive: false } })
      ]);
    }

    dispose();

    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      expect(container.listeners.get(type)).toEqual([]);
    }
  });
});
