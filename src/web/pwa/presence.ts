export interface PresenceReporterDeps {
  /** The push subscription endpoint identifying this device. */
  endpoint: string;
  /** Reports presence to the server (best-effort, fire-and-forget). */
  postPresence: (endpoint: string, foreground: boolean) => void;
  /** Returns whether the page is currently foreground/visible. */
  isVisible: () => boolean;
  /** Subscribes to visibility changes; returns an unsubscribe function. */
  onVisibilityChange: (listener: () => void) => () => void;
  /** Injected timer functions (default to globals). */
  setInterval?: (handler: () => void, ms: number) => number;
  clearInterval?: (handle: number) => void;
  /** Heartbeat period in ms (default 15000). */
  heartbeatMs?: number;
}

export interface PresenceReporter {
  start: () => void;
  dispose: () => void;
}

export function createPresenceReporter(deps: PresenceReporterDeps): PresenceReporter {
  const setIntervalFn = deps.setInterval ?? globalThis.setInterval.bind(globalThis);
  const clearIntervalFn = deps.clearInterval ?? globalThis.clearInterval.bind(globalThis);
  const heartbeatMs = deps.heartbeatMs ?? 15000;

  let intervalHandle: number | null = null;
  let unsubscribe: (() => void) | null = null;
  let started = false;

  const report = () => {
    deps.postPresence(deps.endpoint, deps.isVisible());
  };

  const start = () => {
    if (started) {
      return;
    }
    started = true;

    // Immediately report current visibility
    report();

    // Start heartbeat interval
    intervalHandle = setIntervalFn(() => {
      report();
    }, heartbeatMs);

    // Subscribe to visibility changes
    unsubscribe = deps.onVisibilityChange(() => {
      report();
    });
  };

  const dispose = () => {
    const wasStarted = started;
    if (intervalHandle !== null) {
      clearIntervalFn(intervalHandle);
      intervalHandle = null;
    }
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
    started = false;
    // Proactively tell the server this device is no longer reporting presence so
    // it stops suppressing OS pushes immediately, rather than waiting out the
    // server-side TTL. Only when we had actually started (so dispose-before-start
    // and repeated dispose calls stay quiet).
    if (wasStarted) {
      deps.postPresence(deps.endpoint, false);
    }
  };

  return { start, dispose };
}
