import { describe, expect, test } from "bun:test";
import { createPresenceReporter, type PresenceReporterDeps } from "../src/web/pwa/presence.js";

interface Harness {
  reports: Array<{ endpoint: string; foreground: boolean }>;
  fireInterval: () => void;
  fireVisibilityChange: () => void;
  setVisible: (v: boolean) => void;
  intervalCleared: () => boolean;
  visibilityUnsubscribed: () => boolean;
  deps: PresenceReporterDeps;
}

function harness(endpoint = "https://push/a"): Harness {
  const reports: Array<{ endpoint: string; foreground: boolean }> = [];
  let visible = true;
  let intervalCb: (() => void) | null = null;
  let cleared = false;
  let visListener: (() => void) | null = null;
  let unsubscribed = false;
  const deps: PresenceReporterDeps = {
    endpoint,
    postPresence: (ep, fg) => reports.push({ endpoint: ep, foreground: fg }),
    isVisible: () => visible,
    onVisibilityChange: (listener) => {
      visListener = listener;
      return () => {
        unsubscribed = true;
        visListener = null;
      };
    },
    setInterval: (handler) => {
      intervalCb = handler;
      return 1;
    },
    clearInterval: () => {
      cleared = true;
      intervalCb = null;
    },
    heartbeatMs: 15000,
  };
  return {
    reports,
    fireInterval: () => intervalCb?.(),
    fireVisibilityChange: () => visListener?.(),
    setVisible: (v) => {
      visible = v;
    },
    intervalCleared: () => cleared,
    visibilityUnsubscribed: () => unsubscribed,
    deps,
  };
}

describe("createPresenceReporter", () => {
  test("reports current visibility immediately on start", () => {
    const h = harness();
    createPresenceReporter(h.deps).start();
    expect(h.reports).toEqual([{ endpoint: "https://push/a", foreground: true }]);
  });

  test("re-reports on each heartbeat tick", () => {
    const h = harness();
    const r = createPresenceReporter(h.deps);
    r.start();
    h.setVisible(false);
    h.fireInterval();
    expect(h.reports).toEqual([
      { endpoint: "https://push/a", foreground: true },
      { endpoint: "https://push/a", foreground: false },
    ]);
  });

  test("reports immediately on visibility change", () => {
    const h = harness();
    createPresenceReporter(h.deps).start();
    h.setVisible(false);
    h.fireVisibilityChange();
    expect(h.reports.at(-1)).toEqual({ endpoint: "https://push/a", foreground: false });
  });

  test("dispose clears the interval and unsubscribes; no further reports", () => {
    const h = harness();
    const r = createPresenceReporter(h.deps);
    r.start();
    r.dispose();
    expect(h.intervalCleared()).toBe(true);
    expect(h.visibilityUnsubscribed()).toBe(true);
    const count = h.reports.length;
    h.fireInterval();
    h.fireVisibilityChange();
    expect(h.reports.length).toBe(count);
  });

  test("dispose is idempotent and safe before start", () => {
    const h = harness();
    const r = createPresenceReporter(h.deps);
    expect(() => r.dispose()).not.toThrow();
    r.start();
    r.dispose();
    expect(() => r.dispose()).not.toThrow();
  });

  test("start is guarded against creating a second interval", () => {
    let intervalCount = 0;
    const h = harness();
    const deps: PresenceReporterDeps = {
      ...h.deps,
      setInterval: (_handler) => {
        intervalCount += 1;
        return intervalCount;
      },
    };
    const r = createPresenceReporter(deps);
    r.start();
    r.start();
    expect(intervalCount).toBe(1);
  });
});
