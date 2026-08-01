import {
  beginTwoFingerGesture,
  finishTwoFingerGesture,
  isWheelMomentumActive,
  moveTwoFingerGesture,
  stepWheelMomentum,
  type GesturePoint,
  type GestureTouch,
  type TwoFingerGestureState,
  type WheelMomentum
} from "./twoFingerWheelGesture.js";

export interface WheelDispatchTarget {
  dispatchEvent(event: Event): boolean;
}

export interface AnimationScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
}

export type TerminalTouchWheelOptions = {
  container: HTMLElement;
  getTarget(): WheelDispatchTarget | null;
  getInverted(): boolean;
  scheduler?: AnimationScheduler;
  createEvent?: (type: string, init: WheelEventInit) => Event;
};

const wheelPixelDeltaMode = 0;
const touchListenerOptions = { capture: true, passive: false };

function createNativeWheelEvent(type: string, init: WheelEventInit): Event {
  return new WheelEvent(type, init);
}

function nativeAnimationScheduler(): AnimationScheduler {
  return {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (id) => cancelAnimationFrame(id)
  };
}

function mapTouches(touches: TouchList): GestureTouch[] {
  const mapped: GestureTouch[] = [];
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item?.(index) ?? touches[index];
    if (touch) {
      mapped.push({
        clientX: touch.clientX,
        clientY: touch.clientY,
        screenX: touch.screenX,
        screenY: touch.screenY
      });
    }
  }
  return mapped;
}

function claimTouchEvent(event: TouchEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

export function dispatchTerminalWheel(
  target: WheelDispatchTarget | null | undefined,
  deltaY: number,
  point: GesturePoint | null | undefined,
  createEvent: (type: string, init: WheelEventInit) => Event = createNativeWheelEvent
): boolean {
  if (!target || !point || !Number.isFinite(deltaY) || deltaY === 0) {
    return false;
  }

  return target.dispatchEvent(
    createEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: wheelPixelDeltaMode,
      deltaY,
      clientX: point.clientX,
      clientY: point.clientY,
      screenX: point.screenX,
      screenY: point.screenY
    })
  );
}

export function installTerminalTouchWheel(options: TerminalTouchWheelOptions): () => void {
  const scheduler = options.scheduler ?? nativeAnimationScheduler();
  const createEvent = options.createEvent ?? createNativeWheelEvent;
  let state: TwoFingerGestureState = { phase: "idle" };
  let momentum: WheelMomentum | null = null;
  let momentumFrameId: number | null = null;
  let lastMomentumFrameTime: number | null = null;

  const cancelMomentum = (): void => {
    momentum = null;
    lastMomentumFrameTime = null;
    if (momentumFrameId !== null) {
      scheduler.cancel(momentumFrameId);
      momentumFrameId = null;
    }
  };

  const scheduleMomentum = (): void => {
    if (!momentum || !isWheelMomentumActive(momentum.velocity) || !momentum.point) {
      momentum = null;
      return;
    }

    momentumFrameId = scheduler.request((timeStamp) => {
      momentumFrameId = null;
      if (!momentum || !momentum.point) {
        return;
      }

      const elapsedMs = lastMomentumFrameTime === null ? 16 : timeStamp - lastMomentumFrameTime;
      lastMomentumFrameTime = timeStamp;
      const next = stepWheelMomentum(momentum.velocity, elapsedMs);
      const point = momentum.point;
      dispatchTerminalWheel(options.getTarget(), next.deltaY ?? 0, point, createEvent);
      momentum = { velocity: next.velocity, point };

      if (isWheelMomentumActive(momentum.velocity)) {
        scheduleMomentum();
      } else {
        momentum = null;
        lastMomentumFrameTime = null;
      }
    });
  };

  const handleTouchStart = (event: TouchEvent): void => {
    cancelMomentum();
    state = beginTwoFingerGesture(mapTouches(event.touches), event.timeStamp);
    if (state.phase === "pending") {
      claimTouchEvent(event);
    }
  };

  const handleTouchMove = (event: TouchEvent): void => {
    const move = moveTwoFingerGesture(state, mapTouches(event.touches), event.timeStamp, options.getInverted());
    state = move.state;

    if (!move.claimed) {
      return;
    }

    claimTouchEvent(event);
    dispatchTerminalWheel(options.getTarget(), move.deltaY, move.point, createEvent);
  };

  const handleTouchEnd = (event: TouchEvent): void => {
    const nextMomentum = finishTwoFingerGesture(state, event.touches.length, event.timeStamp, options.getInverted());
    state = { phase: "idle" };
    momentum = nextMomentum;
    lastMomentumFrameTime = null;

    if (momentum && isWheelMomentumActive(momentum.velocity)) {
      scheduleMomentum();
    } else {
      momentum = null;
    }
  };

  const handleTouchCancel = (): void => {
    state = { phase: "idle" };
    cancelMomentum();
  };

  options.container.addEventListener("touchstart", handleTouchStart, touchListenerOptions);
  options.container.addEventListener("touchmove", handleTouchMove, touchListenerOptions);
  options.container.addEventListener("touchend", handleTouchEnd, touchListenerOptions);
  options.container.addEventListener("touchcancel", handleTouchCancel, touchListenerOptions);

  return () => {
    cancelMomentum();
    options.container.removeEventListener("touchstart", handleTouchStart, true);
    options.container.removeEventListener("touchmove", handleTouchMove, true);
    options.container.removeEventListener("touchend", handleTouchEnd, true);
    options.container.removeEventListener("touchcancel", handleTouchCancel, true);
  };
}
