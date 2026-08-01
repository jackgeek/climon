export type GestureTouch = {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
};

export type GesturePoint = GestureTouch & {
  timeStamp: number;
};

type GestureSample = {
  y: number;
  timeStamp: number;
};

type IdleGestureState = {
  phase: "idle";
};

type RejectedGestureState = {
  phase: "rejected";
  point: GesturePoint;
  initialSpan: number;
};

type PendingGestureState = {
  phase: "pending";
  anchor: GesturePoint;
  point: GesturePoint;
  initialSpan: number;
  samples: GestureSample[];
};

type ActiveGestureState = {
  phase: "active";
  anchor: GesturePoint;
  point: GesturePoint;
  initialSpan: number;
  samples: GestureSample[];
};

export type TwoFingerGestureState = IdleGestureState | RejectedGestureState | PendingGestureState | ActiveGestureState;

export type GestureMove = {
  state: TwoFingerGestureState;
  claimed: boolean;
  deltaY: number;
  point?: GesturePoint;
};

export type WheelMomentum = {
  velocity: number;
  point?: GesturePoint;
  deltaY?: number;
};

const ACTIVATION_PX = 8;
const PINCH_REJECTION_PX = 8;
const VERTICAL_DOMINANCE_RATIO = 1.25;
const VELOCITY_WINDOW_MS = 100;
const MOMENTUM_FRICTION_PER_16_MS = 0.92;
const MIN_WHEEL_VELOCITY = 0.02;
const MAX_MOMENTUM_FRAME_MS = 48;

function midpoint(touches: readonly GestureTouch[], timeStamp: number): GesturePoint {
  const [first, second] = touches;
  return {
    clientX: (first.clientX + second.clientX) / 2,
    clientY: (first.clientY + second.clientY) / 2,
    screenX: (first.screenX + second.screenX) / 2,
    screenY: (first.screenY + second.screenY) / 2,
    timeStamp
  };
}

function touchSpan(touches: readonly GestureTouch[]): number {
  const [first, second] = touches;
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function deltaY(previous: GesturePoint, next: GesturePoint, inverted: boolean): number {
  const raw = previous.clientY - next.clientY;
  return inverted ? -raw : raw;
}

function pruneSamples(samples: readonly GestureSample[], timeStamp: number): GestureSample[] {
  return samples.filter((sample) => timeStamp - sample.timeStamp <= VELOCITY_WINDOW_MS);
}

function appendSample(samples: readonly GestureSample[], point: GesturePoint): GestureSample[] {
  return pruneSamples([...samples, { y: point.clientY, timeStamp: point.timeStamp }], point.timeStamp);
}

function settlePending(
  state: PendingGestureState,
  point: GesturePoint,
  span: number,
  inverted: boolean
): GestureMove {
  const samples = appendSample(state.samples, point);
  const dx = point.clientX - state.anchor.clientX;
  const dy = point.clientY - state.anchor.clientY;

  if (Math.abs(span - state.initialSpan) >= PINCH_REJECTION_PX) {
    return {
      state: { phase: "rejected", point, initialSpan: state.initialSpan },
      claimed: true,
      deltaY: 0,
      point
    };
  }

  const movement = Math.hypot(dx, dy);
  if (movement < ACTIVATION_PX) {
    return {
      state: { ...state, point, samples },
      claimed: true,
      deltaY: 0,
      point
    };
  }

  if (Math.abs(dy) < Math.abs(dx) * VERTICAL_DOMINANCE_RATIO) {
    return {
      state: { phase: "rejected", point, initialSpan: state.initialSpan },
      claimed: true,
      deltaY: 0,
      point
    };
  }

  return {
    state: { phase: "active", anchor: state.anchor, point, initialSpan: state.initialSpan, samples },
    claimed: true,
    deltaY: deltaY(state.point, point, inverted),
    point
  };
}

function settleActive(state: ActiveGestureState, point: GesturePoint, inverted: boolean): GestureMove {
  const samples = appendSample(state.samples, point);
  return {
    state: { ...state, point, samples },
    claimed: true,
    deltaY: deltaY(state.point, point, inverted),
    point
  };
}

export function beginTwoFingerGesture(touches: readonly GestureTouch[], timeStamp: number): TwoFingerGestureState {
  if (touches.length !== 2) {
    return { phase: "idle" };
  }

  const point = midpoint(touches, timeStamp);
  return {
    phase: "pending",
    anchor: point,
    point,
    initialSpan: touchSpan(touches),
    samples: [{ y: point.clientY, timeStamp }]
  };
}

export function moveTwoFingerGesture(
  state: TwoFingerGestureState,
  touches: readonly GestureTouch[],
  timeStamp: number,
  inverted: boolean
): GestureMove {
  if (touches.length !== 2) {
    return { state: { phase: "idle" }, claimed: false, deltaY: 0 };
  }

  const point = midpoint(touches, timeStamp);
  const span = touchSpan(touches);

  if (state.phase === "pending") {
    return settlePending(state, point, span, inverted);
  }

  if (state.phase === "active") {
    return settleActive(state, point, inverted);
  }

  if (state.phase === "rejected") {
    return {
      state: { ...state, point },
      claimed: true,
      deltaY: 0,
      point
    };
  }

  return { state: { phase: "idle" }, claimed: false, deltaY: 0 };
}

export function finishTwoFingerGesture(
  state: TwoFingerGestureState,
  remainingTouchCount: number,
  timeStamp: number,
  inverted: boolean
): WheelMomentum | null {
  if (remainingTouchCount !== 0 || state.phase !== "active") {
    return null;
  }

  const samples = pruneSamples(state.samples, timeStamp);
  if (samples.length < 2) {
    return null;
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  const elapsed = last.timeStamp - first.timeStamp;

  if (elapsed <= 0) {
    return null;
  }

  const velocity = inverted ? -(first.y - last.y) / elapsed : (first.y - last.y) / elapsed;
  return {
    point: state.point,
    velocity
  };
}

export function stepWheelMomentum(velocity: number, elapsedMs: number): WheelMomentum {
  const clampedElapsed = Math.max(0, Math.min(MAX_MOMENTUM_FRAME_MS, elapsedMs));
  const deltaY = velocity * clampedElapsed;
  return {
    deltaY,
    velocity: velocity * Math.pow(MOMENTUM_FRICTION_PER_16_MS, clampedElapsed / 16)
  };
}

export function isWheelMomentumActive(velocity: number): boolean {
  return Math.abs(velocity) >= MIN_WHEEL_VELOCITY;
}
