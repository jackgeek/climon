import {
  beginTwoFingerGesture,
  moveTwoFingerGesture,
  type GesturePoint,
  type GestureTouch,
  type TwoFingerGestureState
} from "./twoFingerWheelGesture.js";

export interface WheelDispatchTarget {
  dispatchEvent(event: Event): boolean;
}

export type TerminalTouchWheelOptions = {
  container: HTMLElement;
  getTarget(): WheelDispatchTarget | null;
  getInverted(): boolean;
  createEvent?: (type: string, init: WheelEventInit) => Event;
};

const wheelPixelDeltaMode = 0;
const touchListenerOptions = { capture: true, passive: false };

function createNativeWheelEvent(type: string, init: WheelEventInit): Event {
  return new WheelEvent(type, init);
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
  const createEvent = options.createEvent ?? createNativeWheelEvent;
  let state: TwoFingerGestureState = { phase: "idle" };

  const handleTouchStart = (event: TouchEvent): void => {
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

  const handleTouchEnd = (): void => {
    state = { phase: "idle" };
  };

  const handleTouchCancel = (): void => {
    state = { phase: "idle" };
  };

  options.container.addEventListener("touchstart", handleTouchStart, touchListenerOptions);
  options.container.addEventListener("touchmove", handleTouchMove, touchListenerOptions);
  options.container.addEventListener("touchend", handleTouchEnd, touchListenerOptions);
  options.container.addEventListener("touchcancel", handleTouchCancel, touchListenerOptions);

  return () => {
    options.container.removeEventListener("touchstart", handleTouchStart, true);
    options.container.removeEventListener("touchmove", handleTouchMove, true);
    options.container.removeEventListener("touchend", handleTouchEnd, true);
    options.container.removeEventListener("touchcancel", handleTouchCancel, true);
  };
}
