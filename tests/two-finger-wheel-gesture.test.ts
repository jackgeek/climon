import { describe, expect, test } from "bun:test";
import {
  beginTwoFingerGesture,
  finishTwoFingerGesture,
  isWheelMomentumActive,
  moveTwoFingerGesture,
  stepWheelMomentum,
  type GesturePoint,
  type GestureTouch,
  type TwoFingerGestureState
} from "../src/web/components/twoFingerWheelGesture.js";

function touch(clientX: number, clientY: number, screenX = clientX, screenY = clientY): GestureTouch {
  return { clientX, clientY, screenX, screenY };
}

function pendingState(): TwoFingerGestureState {
  return beginTwoFingerGesture([touch(10, 20), touch(30, 40)], 100);
}

function point(clientX: number, clientY: number, timeStamp: number): GesturePoint {
  return { ...touch(clientX, clientY), timeStamp };
}

describe("two-finger wheel gesture", () => {
  test("arms only on exactly two touches and uses the midpoint", () => {
    const state = beginTwoFingerGesture([touch(10, 20), touch(30, 40)], 100);

    expect(state.phase).toBe("pending");
    if (state.phase === "pending") {
      expect(state.point).toEqual({ clientX: 20, clientY: 30, screenX: 20, screenY: 30, timeStamp: 100 });
      expect(state.initialSpan).toBeCloseTo(Math.hypot(20, 20));
    }
  });

  test("one or three touches stay idle", () => {
    expect(beginTwoFingerGesture([touch(10, 20)], 100).phase).toBe("idle");
    expect(beginTwoFingerGesture([touch(10, 20), touch(30, 40), touch(50, 60)], 100).phase).toBe("idle");
  });

  test("jitter below the activation threshold stays pending and emits zero", () => {
    const state = pendingState();
    const move = moveTwoFingerGesture(state, [touch(11, 21), touch(31, 41)], 110, false);

    expect(move.state.phase).toBe("pending");
    expect(move.claimed).toBe(true);
    expect(move.deltaY).toBe(0);
    if (move.state.phase === "pending") {
      expect(move.state.point).toEqual({ clientX: 21, clientY: 31, screenX: 21, screenY: 31, timeStamp: 110 });
    }
  });

  test("vertical motion past 8px activates and emits a natural delta", () => {
    const state = pendingState();
    const move = moveTwoFingerGesture(state, [touch(10, 12), touch(30, 32)], 110, false);

    expect(move.state.phase).toBe("active");
    expect(move.claimed).toBe(true);
    expect(move.deltaY).toBe(8);
  });

  test("horizontal motion past the threshold is rejected", () => {
    const state = pendingState();
    const move = moveTwoFingerGesture(state, [touch(2, 20), touch(48, 40)], 110, false);

    expect(move.state.phase).toBe("rejected");
    expect(move.claimed).toBe(true);
    expect(move.deltaY).toBe(0);
  });

  test("pinch spread changes of at least 8px are rejected", () => {
    const state = pendingState();
    const move = moveTwoFingerGesture(state, [touch(0, 20), touch(40, 40)], 110, false);

    expect(move.state.phase).toBe("rejected");
    expect(move.claimed).toBe(true);
    expect(move.deltaY).toBe(0);
  });

  test("active moves emit incremental natural deltas from the prior midpoint", () => {
    const armed = pendingState();
    const first = moveTwoFingerGesture(armed, [touch(10, 12), touch(30, 32)], 110, false);
    expect(first.state.phase).toBe("active");
    expect(first.claimed).toBe(true);

    if (first.state.phase !== "active") return;

    const second = moveTwoFingerGesture(first.state, [touch(10, 6), touch(30, 26)], 120, false);

    expect(second.state.phase).toBe("active");
    expect(second.claimed).toBe(true);
    expect(second.deltaY).toBe(6);
  });

  test("inversion flips the emitted delta", () => {
    const state = pendingState();
    const move = moveTwoFingerGesture(state, [touch(10, 12), touch(30, 32)], 110, true);

    expect(move.state.phase).toBe("active");
    expect(move.claimed).toBe(true);
    expect(move.deltaY).toBe(-8);
  });

  test("rejected remains rejected and claimed on a subsequent exact-two move", () => {
    const state = pendingState();
    const rejected = moveTwoFingerGesture(state, [touch(2, 20), touch(48, 40)], 110, false);

    expect(rejected.state.phase).toBe("rejected");
    expect(rejected.claimed).toBe(true);
    if (rejected.state.phase !== "rejected") return;

    const stillRejected = moveTwoFingerGesture(rejected.state, [touch(2, 20), touch(48, 40)], 120, false);

    expect(stillRejected.state.phase).toBe("rejected");
    expect(stillRejected.claimed).toBe(true);
  });

  test("any touch-count change during move cancels to idle", () => {
    const armed = pendingState();
    const active = moveTwoFingerGesture(armed, [touch(10, 12), touch(30, 32)], 110, false);

    expect(active.state.phase).toBe("active");
    if (active.state.phase !== "active") return;

    const cancelled = moveTwoFingerGesture(active.state, [touch(10, 12)], 120, false);

    expect(cancelled.state.phase).toBe("idle");
    expect(cancelled.claimed).toBe(false);
    expect(cancelled.deltaY).toBe(0);
  });

  test("samples older than 100ms are pruned from finish velocity", () => {
    const state: TwoFingerGestureState = {
      phase: "active",
      anchor: point(20, 100, 0),
      point: point(20, 80, 120),
      initialSpan: 20,
      samples: [
        { y: 100, timeStamp: 0 },
        { y: 99, timeStamp: 60 },
        { y: 80, timeStamp: 120 }
      ]
    };

    const momentum = finishTwoFingerGesture(state, 0, false);

    expect(momentum?.velocity).toBeCloseTo(19 / 60, 10);
  });

  test("negative elapsed clamps to zero", () => {
    const step = stepWheelMomentum(2, -16);

    expect(step.deltaY).toBe(0);
    expect(step.velocity).toBe(2);
  });

  test("finishing an active gesture returns momentum with a velocity and last point", () => {
    const armed = beginTwoFingerGesture([touch(10, 20), touch(30, 40)], 0);
    const active = moveTwoFingerGesture(armed, [touch(10, 0), touch(30, 20)], 50, false);

    expect(active.state.phase).toBe("active");
    if (active.state.phase !== "active") return;

    const momentum = finishTwoFingerGesture(active.state, 0, false);

    expect(momentum).not.toBeNull();
    expect(momentum?.point).toEqual({ clientX: 20, clientY: 10, screenX: 20, screenY: 10, timeStamp: 50 });
    expect(momentum?.velocity).toBe(0.4);
  });

  test("one-touch finish cancels momentum", () => {
    const state = pendingState();

    expect(finishTwoFingerGesture(state, 1, false)).toBeNull();
  });

  test("wheel momentum clamps long frames and decays toward stop", () => {
    const step = stepWheelMomentum(1, 1000);

    expect(step.deltaY).toBe(48);
    expect(step.velocity).toBeCloseTo(Math.pow(0.92, 48 / 16), 10);

    let velocity = 0.021;
    let active = isWheelMomentumActive(velocity);
    expect(active).toBe(true);

    const decayed = stepWheelMomentum(velocity, 48);
    velocity = decayed.velocity;
    active = isWheelMomentumActive(velocity);

    expect(active).toBe(false);
  });
});
