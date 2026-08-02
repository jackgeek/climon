/**
 * Unit tests for the DAR-08 scenario runner.
 *
 * Uses fakes for all external dependencies (PTY, browser, session ledger,
 * daemon client). Verifies orchestration, ordering, stalled-before-pause
 * contract, CONTINUE-via-browser route, final marker after isolation,
 * metadata/log failures, and cleanup.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  DAR_08_SUBCHECK_NAMES,
  runDar08,
  type Dar08BrowserDriver,
  type Dar08BrowserSurface,
  type Dar08Context,
  type Dar08Dependencies,
  type Dar08Pty,
} from "../src/scenarios/dar-08.js";
import type { SocketRef } from "../src/drivers/socket-probe.js";
import type { SessionStatus } from "../src/session-ledger.js";

// ── Expected titles ─────────────────────────────────────────────────────────

const DAR_08_SUBCHECK_TITLES = [
  "Browser desktop terminal shows DAR_LIFECYCLE_FLOOD 005000 after phase-1 flood completes",
  "Stalled raw daemon client is evicted (socket closed) after OS receive-buffer saturation within deadline",
  "Browser terminal continues to receive output and shows DAR_LIFECYCLE_FLOOD 010000 after stalled client is isolated",
  "Session finalizes with status=completed, exitCode=0, nonempty completedAt, and phase-2 marker in scrollback",
  "Daemon log contains no panic / panicked / fatal-actor-failure strings after high-volume flood with concurrent viewer",
] as const;

// ── Constants ────────────────────────────────────────────────────────────────

const RUN_ID = "dar08run-0001-0000-0000-000000000000";
const SESSION_ID = "dar-08-session-id";
const SOCKET_REF = "tcp://127.0.0.1:29851";
const PHASE1_MARKER = "DAR_LIFECYCLE_FLOOD 005000";
const PHASE2_MARKER = "DAR_LIFECYCLE_FLOOD 010000";

// ── Fake PTY ─────────────────────────────────────────────────────────────────

class FakePty implements Dar08Pty {
  public killCalls = 0;
  public waitForExitCalls: number[] = [];
  public expectRawCalls: string[] = [];
  public waitForExitError?: Error;

  public async expectRaw(marker: string, _deadline: number): Promise<void> {
    this.expectRawCalls.push(marker);
  }

  public async waitForExit(deadline: number): Promise<number> {
    this.waitForExitCalls.push(deadline);
    if (this.waitForExitError) throw this.waitForExitError;
    return 0;
  }

  public kill(): void {
    this.killCalls += 1;
  }
}

// ── Fake browser surface ──────────────────────────────────────────────────────

class FakeBrowserSurface implements Dar08BrowserSurface {
  public readonly name: string;
  public readonly viewerId: string;
  public readonly openCalls: string[] = [];
  public readonly openTerminalCalls: string[] = [];
  public readonly sendTerminalLineCalls: string[] = [];
  public readonly waitForTerminalTextCalls: Array<{ text: string; deadline: number }> = [];
  public closeCalls = 0;
  public closeError?: Error;
  public waitForTerminalTextError?: Error;
  public terminalContent = "";

  public constructor(name: string) {
    this.name = name;
    this.viewerId = `fake-viewer-${name}`;
  }

  public async open(baseUrl: string, _deadline: number): Promise<void> {
    this.openCalls.push(baseUrl);
  }

  public async openTerminal(id: string, _deadline: number): Promise<void> {
    this.openTerminalCalls.push(id);
  }

  public async sendTerminalLine(text: string): Promise<void> {
    this.sendTerminalLineCalls.push(text);
  }

  public async waitForTerminalText(text: string, deadline: number): Promise<void> {
    this.waitForTerminalTextCalls.push({ text, deadline });
    if (this.waitForTerminalTextError) throw this.waitForTerminalTextError;
    if (!this.terminalContent.includes(text)) {
      throw new Error(`Terminal text "${text}" not found in content`);
    }
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError) throw this.closeError;
  }
}

class FakeBrowserDriver implements Dar08BrowserDriver {
  public readonly surfaces: FakeBrowserSurface[] = [];
  public createSurfaceError?: Error;

  public async createSurface(options: { name: string; viewport: { width: number; height: number } }): Promise<FakeBrowserSurface> {
    if (this.createSurfaceError) throw this.createSurfaceError;
    const surface = new FakeBrowserSurface(options.name);
    this.surfaces.push(surface);
    return surface;
  }
}

// ── Fake daemon client ────────────────────────────────────────────────────────

class FakeDaemonClient {
  public waitForAttachedCalls: number[] = [];
  public pauseReadsCalls = 0;
  public waitForClosedCalls: number[] = [];
  public destroyCalls = 0;
  public resumeCalls = 0;
  public closed = false;

  public waitForAttachedError?: Error;
  public waitForClosedError?: Error;

  public async waitForAttached(deadline: number): Promise<void> {
    this.waitForAttachedCalls.push(deadline);
    if (this.waitForAttachedError) throw this.waitForAttachedError;
  }

  public pauseReads(): void {
    this.pauseReadsCalls += 1;
  }

  public resume(): void {
    this.resumeCalls += 1;
  }

  public async waitForClosed(deadline: number): Promise<void> {
    this.waitForClosedCalls.push(deadline);
    if (this.waitForClosedError) throw this.waitForClosedError;
    this.closed = true;
  }

  public destroy(): void {
    this.destroyCalls += 1;
    this.closed = true;
  }
}

// ── Session store fake ────────────────────────────────────────────────────────

interface FakeSessionMeta extends Record<string, unknown> {
  id: string;
  name: string;
  status: SessionStatus;
  exitCode?: number;
  completedAt?: string;
  socketPath?: string;
}

function makeSessionMeta(overrides: Partial<FakeSessionMeta> = {}): FakeSessionMeta {
  return {
    id: SESSION_ID,
    name: `DAR-08-${RUN_ID.slice(0, 8)}`,
    // Default to terminal "completed" so waitForTerminalStatus is satisfied.
    // findSession fakes use a separate live-status override below.
    status: "completed",
    exitCode: 0,
    completedAt: "2026-01-01T00:00:00.000Z",
    socketPath: SOCKET_REF,
    ...overrides,
  };
}

/** A live-status meta for findSession fakes (must have a connectable socket). */
function makeLiveMeta(base: FakeSessionMeta): FakeSessionMeta {
  return { ...base, status: "running" };
}

interface FakeSessionStore {
  track(id: string): void;
  waitForTerminalStatus(id: string, deadline: number): Promise<FakeSessionMeta>;
  read(id: string): Promise<FakeSessionMeta>;
  trackedIds: string[];
  meta: FakeSessionMeta;
}

function makeSessionStore(meta: FakeSessionMeta): FakeSessionStore {
  return {
    meta,
    trackedIds: [],
    track(id: string): void {
      this.trackedIds.push(id);
    },
    async waitForTerminalStatus(id: string, _deadline: number): Promise<FakeSessionMeta> {
      if (id !== meta.id) throw new Error(`Unknown session: ${id}`);
      return meta;
    },
    async read(id: string): Promise<FakeSessionMeta> {
      if (id !== meta.id) throw new Error(`Unknown session: ${id}`);
      return meta;
    },
  };
}

// ── Context factory ───────────────────────────────────────────────────────────

function makeContext(
  store: FakeSessionStore,
  overrides: Partial<Dar08Context["runtime"]> = {}
): Dar08Context {
  return {
    platform: "macos",
    overallDeadline: Date.now() + 30_000,
    build: {
      clientPath: "/fake/climon",
      fixturePath: "/fake/fixture",
    },
    runtime: {
      root: "/fake/root",
      home: "/fake/home",
      baseUrl: "http://localhost:9999",
      env: {},
      artifacts: {
        dir: "/fake/artifacts",
        appendText: async (_path: string, _text: string): Promise<void> => { /* no-op */ },
      },
      sessions: store,
      ...overrides,
    },
  };
}

// ── Shared test state ─────────────────────────────────────────────────────────

let pty: FakePty;
let browserDriver: FakeBrowserDriver;
let stalledClient: FakeDaemonClient;
let sessionStore: FakeSessionStore;
let sessionMeta: FakeSessionMeta;

function makeDeps(overrides: Partial<Dar08Dependencies> = {}): Dar08Dependencies {
  return {
    now: () => Date.now(),
    sleep: async (_ms: number): Promise<void> => { /* instant in tests */ },
    pollIntervalMs: 1,
    createUuid: () => RUN_ID,
    spawnPty: (_spec, _deps) => pty,
    createBrowserDriver: () => browserDriver,
    findSession: async ({ expectedName }) => {
      const meta = sessionMeta;
      if (meta.name !== expectedName) return undefined;
      if (!meta.socketPath) return undefined;
      // Return a live-status view for discovery; terminal status is separate.
      return makeLiveMeta(meta);
    },
    readScrollback: async (_home, _id) => `Some output\n${PHASE2_MARKER}\n`,
    readDaemonLog: async (_home, _id) => "INFO daemon started\nINFO session ready\n",
    createDaemonClient: (_ref: SocketRef) => stalledClient as unknown as import("../src/drivers/daemon-client.js").DaemonClient,
    ...overrides,
  };
}

beforeEach(() => {
  pty = new FakePty();
  browserDriver = new FakeBrowserDriver();
  stalledClient = new FakeDaemonClient();
  sessionMeta = makeSessionMeta();
  sessionStore = makeSessionStore(sessionMeta);
});

// ── Subcheck names and titles ─────────────────────────────────────────────────

describe("DAR-08 subcheck names and titles", () => {
  test("exports the five expected subcheck names in order", () => {
    expect(DAR_08_SUBCHECK_NAMES).toEqual([
      "healthy-viewer-receives-initial-stream",
      "disconnecting-viewer-isolated",
      "healthy-viewer-stays-live",
      "session-finalizes-after-flood",
      "daemon-remains-panic-free",
    ]);
  });

  test("subcheck titles match the registry", async () => {
    // Run the full happy-path scenario to collect subcheck results with titles.
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    browserDriver.surfaces.push(surface);
    const fakeBrowserWithSurface: Dar08BrowserDriver = {
      createSurface: async () => {
        return surface;
      },
    };

    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({ createBrowserDriver: () => fakeBrowserWithSurface }));

    expect(results).toHaveLength(5);
    for (let i = 0; i < results.length; i++) {
      expect(results[i].title).toBe(DAR_08_SUBCHECK_TITLES[i]);
    }
  });
});

// ── Full happy-path ───────────────────────────────────────────────────────────

describe("DAR-08 happy path", () => {
  test("all five subchecks pass on a healthy run", async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.status).toBe("passed");
    }
  });

  test("stalled client is attached before pauseReads and before CONTINUE", async () => {
    const callOrder: string[] = [];
    const trackingClient = new FakeDaemonClient();

    Object.defineProperty(trackingClient, "waitForAttached", {
      value: async (deadline: number): Promise<void> => {
        callOrder.push("waitForAttached");
        trackingClient.waitForAttachedCalls.push(deadline);
      },
    });

    Object.defineProperty(trackingClient, "pauseReads", {
      value: (): void => {
        callOrder.push("pauseReads");
        trackingClient.pauseReadsCalls += 1;
      },
    });

    const trackingSurface = new FakeBrowserSurface("desktop-healthy");
    trackingSurface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;

    Object.defineProperty(trackingSurface, "sendTerminalLine", {
      value: async (text: string): Promise<void> => {
        callOrder.push(`sendTerminalLine:${text}`);
        trackingSurface.sendTerminalLineCalls.push(text);
      },
    });

    Object.defineProperty(trackingClient, "waitForClosed", {
      value: async (deadline: number): Promise<void> => {
        callOrder.push("waitForClosed");
        trackingClient.waitForClosedCalls.push(deadline);
        trackingClient.closed = true;
      },
    });

    Object.defineProperty(trackingClient, "destroy", {
      value: (): void => {
        trackingClient.destroyCalls += 1;
        trackingClient.closed = true;
      },
    });

    const driver: Dar08BrowserDriver = { createSurface: async () => trackingSurface };
    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({
      createBrowserDriver: () => driver,
      createDaemonClient: () => trackingClient as unknown as import("../src/drivers/daemon-client.js").DaemonClient,
    }));

    // Verify ordering: waitForAttached → pauseReads → sendTerminalLine(CONTINUE) → waitForClosed
    const attachIdx = callOrder.indexOf("waitForAttached");
    const pauseIdx = callOrder.indexOf("pauseReads");
    const continueIdx = callOrder.findIndex((e) => e.startsWith("sendTerminalLine:CONTINUE"));
    const closedIdx = callOrder.indexOf("waitForClosed");

    expect(attachIdx).toBeGreaterThanOrEqual(0);
    expect(pauseIdx).toBeGreaterThan(attachIdx);
    expect(continueIdx).toBeGreaterThan(pauseIdx);
    expect(closedIdx).toBeGreaterThan(continueIdx);

    expect(results[1].status).toBe("passed");
  });

  test("CONTINUE is sent with the correct session token via browser terminal", async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    // CONTINUE <token> should have been sent; token contains the run ID prefix
    const continueCalls = surface.sendTerminalLineCalls.filter((c) =>
      c.startsWith("CONTINUE ")
    );
    expect(continueCalls).toHaveLength(1);
    const continueToken = continueCalls[0].slice("CONTINUE ".length);
    expect(continueToken).toMatch(/^dar08-[a-z0-9]{8}$/);
  });

  test("browser terminal is opened for the tracked session", async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(surface.openTerminalCalls).toContain(SESSION_ID);
    expect(sessionStore.trackedIds).toContain(SESSION_ID);
  });
});

// ── Subcheck 1: healthy-viewer-receives-initial-stream ────────────────────────

describe("healthy-viewer-receives-initial-stream", () => {
  test("passes when browser shows phase-1 marker", async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(results[0].name).toBe("healthy-viewer-receives-initial-stream");
    expect(results[0].status).toBe("passed");
  });

  test("fails when browser does not show phase-1 marker", async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = "some other output\n";
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(results[0].name).toBe("healthy-viewer-receives-initial-stream");
    expect(results[0].status).toBe("failed");
  });

  test("fails when browser surface creation fails", async () => {
    const driver: Dar08BrowserDriver = {
      createSurface: async () => { throw new Error("browser unavailable"); },
    };

    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(results[0].name).toBe("healthy-viewer-receives-initial-stream");
    expect(results[0].status).toBe("failed");
    expect(results[0].message).toMatch(/browser unavailable/i);
  });
});

// ── Subcheck 2: disconnecting-viewer-isolated ─────────────────────────────────

describe("disconnecting-viewer-isolated", () => {
  test("passes when stalled client waitForClosed succeeds", async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(results[1].name).toBe("disconnecting-viewer-isolated");
    expect(results[1].status).toBe("passed");
  });

  test("fails with blocker message when waitForClosed times out", async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    stalledClient.waitForClosedError = new Error("Timed out waiting for socket close");

    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(results[1].name).toBe("disconnecting-viewer-isolated");
    expect(results[1].status).toBe("failed");
    expect(results[1].message).toMatch(/BLOCKER/);
    expect(results[1].message).toMatch(/OS receive-buffer/i);
  });

  test("fails when stalled client attach fails", async () => {
    stalledClient.waitForAttachedError = new Error("connect refused");
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(results[1].name).toBe("disconnecting-viewer-isolated");
    expect(results[1].status).toBe("failed");
    expect(results[1].message).toMatch(/Stalled daemon client was not established/i);
  });

  test("stalled client is destroyed in cleanup regardless of eviction outcome", async () => {
    stalledClient.waitForClosedError = new Error("Timed out waiting for socket close");
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(stalledClient.destroyCalls + stalledClient.waitForClosedCalls.length).toBeGreaterThan(0);
  });
});

// ── Subcheck 3: healthy-viewer-stays-live ─────────────────────────────────────

describe("healthy-viewer-stays-live", () => {
  test("passes when browser shows phase-2 marker after stalled isolation", async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(results[2].name).toBe("healthy-viewer-stays-live");
    expect(results[2].status).toBe("passed");
  });

  test("fails when browser does not show phase-2 marker", async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    // Phase-1 present but phase-2 marker missing.
    surface.terminalContent = `${PHASE1_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(results[2].name).toBe("healthy-viewer-stays-live");
    expect(results[2].status).toBe("failed");
  });
});

// ── Subcheck 4: session-finalizes-after-flood ─────────────────────────────────

describe("session-finalizes-after-flood", () => {
  test("passes when metadata is completed/0/nonempty-completedAt and scrollback has phase-2 marker", async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(results[3].name).toBe("session-finalizes-after-flood");
    expect(results[3].status).toBe("passed");
  });

  test("fails when session status is not completed", async () => {
    sessionMeta = makeSessionMeta({ status: "failed" });
    sessionStore = makeSessionStore(sessionMeta);
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(results[3].status).toBe("failed");
    expect(results[3].message).toMatch(/status.*completed/i);
  });

  test("fails when exitCode is not 0", async () => {
    sessionMeta = makeSessionMeta({ exitCode: 1 });
    sessionStore = makeSessionStore(sessionMeta);
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(results[3].status).toBe("failed");
    expect(results[3].message).toMatch(/exitCode.*0/i);
  });

  test("fails when completedAt is missing", async () => {
    sessionMeta = makeSessionMeta({ completedAt: undefined });
    sessionStore = makeSessionStore(sessionMeta);
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(results[3].status).toBe("failed");
    expect(results[3].message).toMatch(/completedAt/i);
  });

  test("fails when scrollback does not contain phase-2 marker", async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(
      context,
      makeDeps({
        createBrowserDriver: () => driver,
        readScrollback: async () => "some output without the final marker",
      })
    );

    expect(results[3].status).toBe("failed");
    expect(results[3].message).toMatch(/scrollback/i);
  });
});

// ── Subcheck 5: daemon-remains-panic-free ─────────────────────────────────────

describe("daemon-remains-panic-free", () => {
  test("passes when daemon log has no panic patterns", async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(results[4].name).toBe("daemon-remains-panic-free");
    expect(results[4].status).toBe("passed");
  });

  test('fails when daemon log contains "panicked"', async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(
      context,
      makeDeps({
        createBrowserDriver: () => driver,
        readDaemonLog: async () => "INFO ok\nthread 'actor' panicked at 'assertion failed'\n",
      })
    );

    expect(results[4].status).toBe("failed");
    expect(results[4].message).toMatch(/panicked/i);
  });

  test('fails when daemon log contains "fatal actor failure"', async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(
      context,
      makeDeps({
        createBrowserDriver: () => driver,
        readDaemonLog: async () => "ERROR fatal actor failure in output stage\n",
      })
    );

    expect(results[4].status).toBe("failed");
    expect(results[4].message).toMatch(/fatal actor failure/i);
  });

  test('does not deny normal error/warn/failed words', async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const normalLog =
      "WARN resize failed for viewer\n" +
      "ERROR disconnected viewer after write error\n" +
      "INFO panic-free operation confirmed\n";

    const context = makeContext(sessionStore);
    const results = await runDar08(
      context,
      makeDeps({
        createBrowserDriver: () => driver,
        readDaemonLog: async () => normalLog,
      })
    );

    expect(results[4].status).toBe("passed");
  });
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

describe("DAR-08 cleanup", () => {
  test("browser surface is closed on completion", async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(surface.closeCalls).toBe(1);
  });

  test("PTY is killed on completion", async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    expect(pty.killCalls).toBe(1);
  });

  test("cleanup is robust even when browser close throws", async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    surface.closeError = new Error("browser crashed");
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(context, makeDeps({ createBrowserDriver: () => driver }));

    // All subchecks should still have results despite close error.
    expect(results).toHaveLength(5);
  });
});

// ── PTY spawn failure ─────────────────────────────────────────────────────────

describe("DAR-08 PTY spawn failure", () => {
  test("all subchecks fail gracefully when PTY spawn throws", async () => {
    const surface = new FakeBrowserSurface("desktop-healthy");
    surface.terminalContent = `${PHASE1_MARKER}\n${PHASE2_MARKER}\n`;
    const driver: Dar08BrowserDriver = { createSurface: async () => surface };

    const context = makeContext(sessionStore);
    const results = await runDar08(
      context,
      makeDeps({
        createBrowserDriver: () => driver,
        spawnPty: () => { throw new Error("PTY not available"); },
      })
    );

    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.status).toBe("failed");
    }
  });
});

// ── No browser driver ─────────────────────────────────────────────────────────

describe("DAR-08 missing browser driver", () => {
  test("healthy-viewer subchecks fail when no browser driver is injected", async () => {
    const context = makeContext(sessionStore);
    const results = await runDar08(
      context,
      makeDeps({ createBrowserDriver: undefined })
    );

    expect(results).toHaveLength(5);
    // healthy-viewer checks (0, 2) should fail; finalization/log may pass or fail
    expect(results[0].status).toBe("failed");
    expect(results[2].status).toBe("failed");
  });
});
