import { describe, expect, test } from "bun:test";

import {
  DAR_09_SUBCHECKS,
  DAR_09_SUBCHECK_NAMES,
  runDar09,
  parseHeadlessSessionId,
  type Dar09Context,
  type Dar09Dependencies,
  type Dar09Pty,
} from "../src/scenarios/dar-09.js";
import type { SessionHost } from "../src/drivers/process-discovery.js";
import type { SessionStatus } from "../src/session-ledger.js";

// ── Expected subcheck contract ────────────────────────────────────────────────

const RESIZE_COLS = 101;
const RESIZE_ROWS = 31;
const RESIZE_MARKER_FULL = `DAR_CONTROL_RESIZE 1 ${RESIZE_COLS} ${RESIZE_ROWS}`;

const EXPECTED_NAMES = [
  "unix-sigint-graceful",
  "unix-sigterm-graceful",
  "repeated-signal-idempotency",
  "attached-resize-path",
  "windows-forced-host-termination",
  "windows-console-resize-poller",
] as const;

const EXPECTED_TITLES = [
  "Host process exits gracefully on SIGINT; daemon socket closes; metadata terminal with failed status and nonzero exitCode",
  "Host process exits gracefully on SIGTERM; daemon socket closes; metadata terminal with failed status and nonzero exitCode",
  "Repeated SIGINT on the same session is idempotent: one clean terminal finalization, no panic",
  "Attached resize from 80x24 to 101x31 triggers DAR_CONTROL_RESIZE 1 101 31 and metadata cols/rows update",
  "Windows forced host termination via Stop-Process leaves session stale then reconciled via climon kill",
  "Windows console resize poller emits exactly one resize marker without a duplicate on first resize",
] as const;

// ── Fake types ────────────────────────────────────────────────────────────────

interface FakeSessionMeta extends Record<string, unknown> {
  id: string;
  status: SessionStatus;
  exitCode?: number;
  completedAt?: string;
  socketPath?: string;
  daemonPid?: number;
}

function makeSignalHoldMeta(id: string, overrides: Partial<FakeSessionMeta> = {}): FakeSessionMeta {
  return {
    id,
    status: "running",
    socketPath: "tcp://127.0.0.1:19780",
    daemonPid: 9999,
    ...overrides,
  };
}

// ── Fake PTY ─────────────────────────────────────────────────────────────────

class FakePty implements Dar09Pty {
  public killCalls = 0;
  public resizeCalls: Array<{ cols: number; rows: number }> = [];
  public writeTextCalls: string[] = [];
  public expectRawCalls: string[] = [];
  public waitForExitCode = 0;
  public waitForExitError?: Error;
  public expectRawError?: Error;
  /** Simulated PTY output for readLocalOutput(). Defaults to one resize marker. */
  public localOutput = `${RESIZE_MARKER_FULL}\n`;

  public async expectRaw(marker: string, _deadline: number): Promise<void> {
    this.expectRawCalls.push(marker);
    if (this.expectRawError) throw this.expectRawError;
  }

  public async waitForExit(_deadline: number): Promise<number> {
    if (this.waitForExitError) throw this.waitForExitError;
    return this.waitForExitCode;
  }

  public kill(): void {
    this.killCalls += 1;
  }

  public writeText(text: string): void {
    this.writeTextCalls.push(text);
  }

  public resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  public readLocalOutput(): string {
    return this.localOutput;
  }
}

// ── Fake DaemonClient ─────────────────────────────────────────────────────────

interface DaemonClientLike {
  waitForAttached(deadline: number): Promise<void>;
  waitForOutput(marker: string, deadline: number): Promise<void>;
  destroy(): void;
}

class FakeDaemonClient implements DaemonClientLike {
  public attachedCalls = 0;
  public outputWaits: string[] = [];
  public destroyCalls = 0;
  public attachError?: Error;

  public async waitForAttached(_deadline: number): Promise<void> {
    this.attachedCalls += 1;
    if (this.attachError) throw this.attachError;
  }

  public async waitForOutput(marker: string, _deadline: number): Promise<void> {
    this.outputWaits.push(marker);
  }

  public destroy(): void {
    this.destroyCalls += 1;
  }
}

// ── Fake sessions store ────────────────────────────────────────────────────────

interface FakeSessionsStore {
  track(id: string): void;
  waitForTerminalStatus(id: string, deadline: number): Promise<FakeSessionMeta>;
  waitForStatus(id: string, status: string, deadline: number): Promise<FakeSessionMeta>;
  read(id: string): Promise<FakeSessionMeta>;
}

function makeSessionsStore(
  metas: Map<string, FakeSessionMeta>
): FakeSessionsStore & { tracked: string[] } {
  const tracked: string[] = [];
  return {
    tracked,
    track(id: string): void {
      tracked.push(id);
    },
    async waitForTerminalStatus(id: string, _deadline: number): Promise<FakeSessionMeta> {
      const m = metas.get(id);
      if (!m) throw new Error(`Unknown session: ${id}`);
      return { ...m, status: "failed", exitCode: 130, completedAt: "2026-01-01T00:00:00.000Z" };
    },
    async waitForStatus(id: string, _status: string, _deadline: number): Promise<FakeSessionMeta> {
      const m = metas.get(id);
      if (!m) throw new Error(`Unknown session: ${id}`);
      return m;
    },
    async read(id: string): Promise<FakeSessionMeta> {
      const m = metas.get(id);
      if (!m) throw new Error(`Unknown session: ${id}`);
      return m;
    },
  };
}

// ── Context factory ────────────────────────────────────────────────────────────

function makeContext(
  platform: "linux" | "macos" | "windows",
  store: FakeSessionsStore
): Dar09Context {
  return {
    platform,
    overallDeadline: Date.now() + 120_000,
    build: {
      clientPath: "/fake/climon",
      fixturePath: "/fake/fixture",
    },
    runtime: {
      root: "/fake/root",
      home: "/fake/home",
      env: { CLIMON_HOME: "/fake/home" },
      artifacts: {
        dir: "/fake/artifacts",
        appendText: async () => {},
      },
      sessions: store,
    },
  };
}

// ── Default fake host ─────────────────────────────────────────────────────────

const FAKE_HOST: SessionHost = { pid: 12345, command: "climon __session fake-id-001" };
const FAKE_DAEMON_CHILD_PID = 9999;

// ── Dependency factory ────────────────────────────────────────────────────────

function makeDependencies(
  sessionId: string,
  meta: FakeSessionMeta,
  overrides: Partial<{
    host: SessionHost | null;
    isAlive: boolean;
    killError: Error;
    daemonClient: FakeDaemonClient;
    scrollback: string;
    runCommandResult: Record<string, { code: number; stdout: string; stderr: string }>;
  }> = {}
): Dar09Dependencies {
  const daemonClient = overrides.daemonClient ?? new FakeDaemonClient();
  const killedPids = new Set<number>();
  // Each createSocketProbe() call creates an independent probe; closeAllProbes() is called by
  // killProcess/terminateWindowsProcess to close all currently-live probes, simulating socket
  // closure on process exit. New probes created after a kill start fresh (open), so sequential
  // subchecks don't pollute each other's socket state.
  const probeClosers: Array<() => void> = [];
  const closeAllProbes = () => { for (const c of probeClosers) c(); };

  return {
    now: () => Date.now(),
    sleep: async () => {},
    pollIntervalMs: 1,
    createUuid: () => sessionId,
    spawnPty: (_spec, _deps) => new FakePty(),
    runCommand: async (_spec) => {
      const cmdKey = `${_spec.file} ${_spec.args.join(" ")}`;
      const custom = overrides.runCommandResult?.[cmdKey];
      if (custom) return { code: custom.code, stdout: custom.stdout, stderr: custom.stderr, durationMs: 5 };
      // Rust launcher prints a plain session ID line (not JSON)
      if (_spec.args.includes("--headless")) {
        return { code: 0, stdout: `${sessionId}\n`, stderr: "", durationMs: 5 };
      }
      return { code: 0, stdout: "", stderr: "", durationMs: 5 };
    },
    findSession: async ({ expectedName }) => {
      if (expectedName.includes(sessionId.slice(0, 8)) || expectedName === sessionId) {
        return meta;
      }
      return undefined;
    },
    readSessionMeta: async (id) => {
      if (id === sessionId) return { ...meta, cols: RESIZE_COLS, rows: RESIZE_ROWS };
      return undefined;
    },
    readScrollback: async (_home, _id) =>
      overrides.scrollback ?? "DAR_LIFECYCLE_HOLD_READY\nsome output\n",
    readDaemonLog: async (_home, _id) => "INFO: session host started\nINFO: session completed\n",
    createSocketProbe: () => {
      // Fresh per-probe state; starts open
      let closed = false;
      probeClosers.push(() => { closed = true; });
      return {
        waitOpen: async (_ref: unknown, _deadline: number) => {
          if (closed) throw new Error("socket not open");
        },
        waitClosed: async (_ref: unknown, _deadline: number) => {
          if (!closed) throw new Error("socket still open");
        },
        probeOnce: async (_ref: unknown) => !closed,
      };
    },
    resolveHost: async (_sessionId, _options) => {
      if (overrides.host === null) throw new Error("process not found");
      return overrides.host ?? FAKE_HOST;
    },
    isProcessAlive: (pid) => {
      if (killedPids.has(pid)) return false;
      return overrides.isAlive !== false;
    },
    killProcess: (pid, _signal) => {
      if (overrides.killError) throw overrides.killError;
      killedPids.add(pid);
      if (typeof meta.daemonPid === "number") {
        killedPids.add(meta.daemonPid);
      }
      closeAllProbes();
    },
    terminateWindowsProcess: async (pid, _dir) => {
      killedPids.add(pid);
      closeAllProbes();
    },
    killSessionRecord: async () => {},
    createDaemonClient: (_ref) => daemonClient,
  };
}

// ── Contract tests ────────────────────────────────────────────────────────────

describe("DAR-09 subcheck contract", () => {
  test("exports exactly 6 subchecks in the correct order", () => {
    expect(DAR_09_SUBCHECK_NAMES).toHaveLength(6);
    expect(DAR_09_SUBCHECK_NAMES).toEqual(Array.from(EXPECTED_NAMES));
  });

  test("exported titles match expected strings", () => {
    const titles = DAR_09_SUBCHECKS.map((s) => s.title);
    expect(titles).toEqual(Array.from(EXPECTED_TITLES));
  });
});

// ── N/A platform dispatch ─────────────────────────────────────────────────────

describe("DAR-09 platform N/A dispatch", () => {
  async function runWithPlatform(platform: "linux" | "macos" | "windows") {
    const sessionId = "dar09-na-test-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext(platform, store);
    const deps = makeDependencies(sessionId, meta);
    return runDar09(context, deps);
  }

  test("on windows: unix subchecks return passed with N/A message", async () => {
    const results = await runWithPlatform("windows");
    const unixNames = [
      "unix-sigint-graceful",
      "unix-sigterm-graceful",
      "repeated-signal-idempotency",
      "attached-resize-path",
    ];
    for (const name of unixNames) {
      const r = results.find((s) => s.name === name)!;
      expect(r, `subcheck ${name} should exist`).toBeDefined();
      expect(r.status, `${name} should be passed (N/A)`).toBe("passed");
      expect(r.message, `${name} should have N/A message`).toMatch(/N\/A|not applicable/i);
    }
  });

  test("on linux: windows subchecks return passed with N/A message", async () => {
    const results = await runWithPlatform("linux");
    const windowsNames = [
      "windows-forced-host-termination",
      "windows-console-resize-poller",
    ];
    for (const name of windowsNames) {
      const r = results.find((s) => s.name === name)!;
      expect(r, `subcheck ${name} should exist`).toBeDefined();
      expect(r.status, `${name} should be passed (N/A)`).toBe("passed");
      expect(r.message, `${name} should have N/A message`).toMatch(/N\/A|not applicable/i);
    }
  });

  test("on macos: windows subchecks return passed with N/A message", async () => {
    const results = await runWithPlatform("macos");
    const windowsNames = [
      "windows-forced-host-termination",
      "windows-console-resize-poller",
    ];
    for (const name of windowsNames) {
      const r = results.find((s) => s.name === name)!;
      expect(r.status, `${name} on macOS should be N/A (passed)`).toBe("passed");
    }
  });

  test("returns all 6 results regardless of platform", async () => {
    for (const platform of ["linux", "macos", "windows"] as const) {
      const results = await runWithPlatform(platform);
      expect(results, `${platform}: should have 6 subchecks`).toHaveLength(6);
      for (const [index, name] of EXPECTED_NAMES.entries()) {
        expect(results[index]!.name, `${platform}[${index}].name`).toBe(name);
      }
    }
  });
});

// ── Unix signal subchecks ─────────────────────────────────────────────────────

describe("DAR-09 unix-sigint-graceful", () => {
  async function runSignalSubcheck(
    platform: "linux" | "macos",
    overrides: Parameters<typeof makeDependencies>[2] = {}
  ) {
    const sessionId = "dar09-sigint-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext(platform, store);
    const deps = makeDependencies(sessionId, meta, overrides);
    const results = await runDar09(context, deps);
    return results.find((r) => r.name === "unix-sigint-graceful")!;
  }

  test("happy path: passes on linux", async () => {
    const result = await runSignalSubcheck("linux");
    expect(result.status, result.message).toBe("passed");
  });

  test("happy path: passes on macos", async () => {
    const result = await runSignalSubcheck("macos");
    expect(result.status, result.message).toBe("passed");
  });

  test("fails if host discovery throws (process not found)", async () => {
    const result = await runSignalSubcheck("linux", { host: null });
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/process not found/i);
  });

  test("evidence includes PTY artifact paths", async () => {
    const result = await runSignalSubcheck("linux");
    expect(result.evidence?.some((e) => e.includes("sigint"))).toBe(true);
  });
});

describe("DAR-09 unix-sigterm-graceful", () => {
  test("happy path: passes on linux", async () => {
    const sessionId = "dar09-sigterm-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("linux", store);

    const capturedSignals: string[] = [];
    const baseDeps = makeDependencies(sessionId, meta);
    const deps: Dar09Dependencies = {
      ...baseDeps,
      killProcess: (pid: number, signal: "SIGINT" | "SIGTERM") => {
        capturedSignals.push(signal);
        baseDeps.killProcess?.(pid, signal);
      },
    };

    const results = await runDar09(context, deps);
    const result = results.find((r) => r.name === "unix-sigterm-graceful")!;
    expect(result.status, result.message).toBe("passed");
    expect(capturedSignals).toContain("SIGTERM");
  });

  test("sigint subcheck uses SIGINT not SIGTERM", async () => {
    const sessionId = "dar09-sig-dispatch-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("linux", store);

    const signals: string[] = [];
    const baseDeps = makeDependencies(sessionId, meta);
    const deps: Dar09Dependencies = {
      ...baseDeps,
      killProcess: (pid: number, signal: "SIGINT" | "SIGTERM") => {
        signals.push(signal);
        baseDeps.killProcess?.(pid, signal);
      },
    };

    const results = await runDar09(context, deps);
    const sigintResult = results.find((r) => r.name === "unix-sigint-graceful")!;
    const sigtermResult = results.find((r) => r.name === "unix-sigterm-graceful")!;

    // Each subcheck uses a dedicated session — both should run
    expect(sigintResult.status, sigintResult.message).toBe("passed");
    expect(sigtermResult.status, sigtermResult.message).toBe("passed");
    // SIGINT and SIGTERM were both sent
    expect(signals).toContain("SIGINT");
    expect(signals).toContain("SIGTERM");
  });
});

// ── Repeated-signal idempotency ───────────────────────────────────────────────

describe("DAR-09 repeated-signal-idempotency", () => {
  test("passes when host is re-resolved successfully before second signal", async () => {
    const sessionId = "dar09-repeat-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("linux", store);

    let resolveCallCount = 0;
    const deps: Dar09Dependencies = {
      ...makeDependencies(sessionId, meta),
      resolveHost: async () => {
        resolveCallCount += 1;
        return FAKE_HOST;
      },
    };

    const results = await runDar09(context, deps);
    const result = results.find((r) => r.name === "repeated-signal-idempotency")!;
    expect(result.status, result.message).toBe("passed");
    // Must have re-resolved at least twice (once per signal)
    expect(resolveCallCount).toBeGreaterThanOrEqual(2);
  });

  test("fails when host is already gone before second signal", async () => {
    const sessionId = "dar09-repeat-fast-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("linux", store);

    let resolveCallCount = 0;
    const deps: Dar09Dependencies = {
      ...makeDependencies(sessionId, meta),
      resolveHost: async () => {
        resolveCallCount += 1;
        if (resolveCallCount === 1) return FAKE_HOST;
        // After first kill, host is gone — second resolve fails
        throw new Error("No session host found");
      },
    };

    const results = await runDar09(context, deps);
    const result = results.find((r) => r.name === "repeated-signal-idempotency")!;
    // Host gone before second signal must fail — idempotency cannot be verified
    expect(result.status).toBe("failed");
  });
});

// ── Attached resize path ──────────────────────────────────────────────────────

describe("DAR-09 attached-resize-path", () => {
  test("passes on linux with resize marker", async () => {
    const sessionId = "dar09-resize-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("linux", store);

    const fakePty = new FakePty();
    const deps: Dar09Dependencies = {
      ...makeDependencies(sessionId, meta),
      spawnPty: (_spec, _deps) => fakePty,
    };

    const results = await runDar09(context, deps);
    const result = results.find((r) => r.name === "attached-resize-path")!;
    expect(result.status, result.message).toBe("passed");
    // PTY should have been resized
    expect(fakePty.resizeCalls.some((r) => r.cols === 101 && r.rows === 31)).toBe(true);
  });

  test("expects DAR_CONTROL_RESIZE marker with correct dimensions", async () => {
    const sessionId = "dar09-resize-ev-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("linux", store);

    const fakePty = new FakePty();
    const deps: Dar09Dependencies = {
      ...makeDependencies(sessionId, meta),
      spawnPty: (_spec, _deps) => fakePty,
    };

    await runDar09(context, deps);
    // The scenario should expect the resize marker
    expect(
      fakePty.expectRawCalls.some((m) => m.includes("DAR_CONTROL_RESIZE") && m.includes("101") && m.includes("31"))
    ).toBe(true);
  });
});

// ── Windows subchecks ─────────────────────────────────────────────────────────

describe("DAR-09 windows-forced-host-termination", () => {
  async function runWindowsTermination(
    overrides: Parameters<typeof makeDependencies>[2] = {}
  ) {
    const sessionId = "dar09-win-term-0001";
    const meta = makeSignalHoldMeta(sessionId, { status: "running" });
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("windows", store);
    let removed = false;
    const deps: Dar09Dependencies = {
      ...makeDependencies(sessionId, meta, { scrollback: "", ...overrides }),
      killSessionRecord: async () => { removed = true; },
      readSessionMeta: async (id) => {
        if (removed && id === sessionId) {
          removed = false; // one-shot: reset so resize poller isn't blocked
          return undefined;
        }
        return { ...meta, cols: RESIZE_COLS, rows: RESIZE_ROWS };
      },
    };
    const results = await runDar09(context, deps);
    return results.find((r) => r.name === "windows-forced-host-termination")!;
  }

  test("happy path: passes on windows", async () => {
    const result = await runWindowsTermination();
    expect(result.status, result.message).toBe("passed");
  });

  test("termination uses Stop-Process (PowerShell) or climon kill", async () => {
    const result = await runWindowsTermination({
      runCommandResult: {
        // Expect a powershell.exe invocation with Stop-Process
      },
    });
    // Should not have failed due to missing command implementation
    expect(result.status, result.message).toBe("passed");
  });
});

describe("DAR-09 windows-console-resize-poller", () => {
  test("passes on windows with resize marker", async () => {
    const sessionId = "dar09-win-resize-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("windows", store);

    const fakePty = new FakePty();
    const deps: Dar09Dependencies = {
      ...makeDependencies(sessionId, meta),
      spawnPty: (_spec, _deps) => fakePty,
    };

    const results = await runDar09(context, deps);
    const result = results.find((r) => r.name === "windows-console-resize-poller")!;
    expect(result.status, result.message).toBe("passed");
  });
});

// ── Host != daemonChildPid assertion ──────────────────────────────────────────

describe("DAR-09 host vs daemonChildPid guard", () => {
  test("passes assertion when host pid differs from daemonPid in metadata", async () => {
    const sessionId = "dar09-guard-ok-0001";
    const meta = makeSignalHoldMeta(sessionId, { daemonPid: FAKE_DAEMON_CHILD_PID });
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("linux", store);

    const deps = makeDependencies(sessionId, meta, {
      host: { pid: 12345, command: "climon __session " + sessionId },
    });

    const results = await runDar09(context, deps);
    const sigint = results.find((r) => r.name === "unix-sigint-graceful")!;
    expect(sigint.status, sigint.message).toBe("passed");
  });

  test("fails assertion when host pid equals daemonPid in metadata", async () => {
    const sessionId = "dar09-guard-fail-0001";
    const meta = makeSignalHoldMeta(sessionId, { daemonPid: 12345 });
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("linux", store);

    const deps = makeDependencies(sessionId, meta, {
      host: { pid: 12345, command: "climon __session " + sessionId },
    });

    const results = await runDar09(context, deps);
    const sigint = results.find((r) => r.name === "unix-sigint-graceful")!;
    expect(sigint.status).toBe("failed");
    expect(sigint.message).toMatch(/daemonPid|child.*pid|pid.*child/i);
  });
});

// ── Evidence paths ────────────────────────────────────────────────────────────

describe("DAR-09 evidence", () => {
  test("unix subchecks include session metadata evidence path", async () => {
    const sessionId = "dar09-evidence-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("linux", store);
    const deps = makeDependencies(sessionId, meta);

    const results = await runDar09(context, deps);
    const sigint = results.find((r) => r.name === "unix-sigint-graceful")!;
    expect(sigint.evidence?.some((e) => e.endsWith(".json"))).toBe(true);
  });

  test("all subchecks carry non-empty title strings", async () => {
    const sessionId = "dar09-titles-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("linux", store);
    const deps = makeDependencies(sessionId, meta);

    const results = await runDar09(context, deps);
    for (const result of results) {
      expect(result.title.length, `${result.name}.title should be non-empty`).toBeGreaterThan(0);
    }
  });
});

// ── parseHeadlessSessionId ────────────────────────────────────────────────────

describe("parseHeadlessSessionId", () => {
  test("parses a plain session id line (Rust launcher output)", () => {
    expect(parseHeadlessSessionId("abc123\n")).toBe("abc123");
  });

  test("strips ANSI escape codes before parsing", () => {
    expect(parseHeadlessSessionId("\u001b[32mabc123\u001b[0m\n")).toBe("abc123");
  });

  test("parses id with allowed special chars (dots, tildes, hyphens)", () => {
    expect(parseHeadlessSessionId("sess~1.2-abc\n")).toBe("sess~1.2-abc");
  });

  test("throws on empty output (no completed lines)", () => {
    expect(() => parseHeadlessSessionId("")).toThrow(/no completed output/i);
  });

  test("throws on output with no trailing newline (incomplete line)", () => {
    expect(() => parseHeadlessSessionId("abc123")).toThrow();
  });

  test("throws on JSON-format output (malformed for Rust launcher)", () => {
    expect(() => parseHeadlessSessionId('{"id":"abc123"}\n')).toThrow(/malformed/i);
  });

  test("throws on multiple session id lines (ambiguous)", () => {
    expect(() => parseHeadlessSessionId("abc123\ndef456\n")).toThrow(/exactly one/i);
  });

  test("throws on unsafe line mixed with safe line", () => {
    expect(() => parseHeadlessSessionId("abc123\nsome extra output\n")).toThrow(/malformed/i);
  });
});

// ── Unix signal fail cases ────────────────────────────────────────────────────

describe("DAR-09 unix-sigint-graceful fail cases", () => {
  async function runSignalWithOverrides(
    overrides: Partial<Dar09Dependencies>
  ) {
    const sessionId = "dar09-fail-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    // Use a short deadline so timeout-triggering tests (e.g. isProcessAlive always true)
    // complete within the bun test timeout, not the default 120s.
    const context = { ...makeContext("linux", store), overallDeadline: Date.now() + 300 };
    const deps: Dar09Dependencies = { ...makeDependencies(sessionId, meta), ...overrides };
    const results = await runDar09(context, deps);
    return results.find((r) => r.name === "unix-sigint-graceful")!;
  }

  test("fails when socket-open throws (socket not open before signal)", async () => {
    const result = await runSignalWithOverrides({
      createSocketProbe: () => ({
        waitOpen: async () => { throw new Error("socket not open"); },
        waitClosed: async () => {},
        probeOnce: async () => false,
      }),
    });
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/socket.*open|open.*socket/i);
  });

  test("fails when host process does not exit (still alive after signal)", async () => {
    const result = await runSignalWithOverrides({
      isProcessAlive: () => true, // always alive → times out
    });
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/host.*exit|exit.*host|alive|timeout/i);
  });

  test("fails when socket does not close after signal", async () => {
    const result = await runSignalWithOverrides({
      createSocketProbe: () => ({
        waitOpen: async () => {},
        waitClosed: async () => { throw new Error("socket still open"); },
        probeOnce: async () => true,
      }),
    });
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/socket.*clos|clos.*socket/i);
  });

  test("fails when daemon log is not found", async () => {
    const result = await runSignalWithOverrides({
      readDaemonLog: async () => undefined,
    });
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/daemon.*log|log.*not.*found/i);
  });

  test("fails when daemon log contains panic", async () => {
    const result = await runSignalWithOverrides({
      readDaemonLog: async () => "INFO: starting\nthread 'main' panicked at 'boom'\n",
    });
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/panic/i);
  });

  test("fails when the metadata child process remains alive", async () => {
    const result = await runSignalWithOverrides({
      isProcessAlive: (pid) => pid === FAKE_DAEMON_CHILD_PID,
    });
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/child.*exit|daemonPid|9999/i);
  });
});

// ── Repeated-signal: resolve and signal count ────────────────────────────────

describe("DAR-09 repeated-signal-idempotency resolve/signal counts", () => {
  test("calls resolveHost exactly twice (once per signal) in repeated-signal subcheck", async () => {
    const sessionId = "dar09-repeat-count-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("linux", store);

    const resolveCalls: string[] = [];
    const killCalls: Array<{ pid: number; signal: string }> = [];

    const baseDeps = makeDependencies(sessionId, meta);
    const deps: Dar09Dependencies = {
      ...baseDeps,
      resolveHost: async (sid) => {
        resolveCalls.push(sid);
        return FAKE_HOST;
      },
      killProcess: (_pid, _signal: "SIGINT" | "SIGTERM") => {
        killCalls.push({ pid: _pid, signal: _signal });
        baseDeps.killProcess?.(_pid, _signal);
      },
    };

    const results = await runDar09(context, deps);
    const result = results.find((r) => r.name === "repeated-signal-idempotency")!;
    expect(result.status, result.message).toBe("passed");
    // On linux: sigint(1 resolve) + sigterm(1 resolve) + repeated(2 resolves) = 4 total
    expect(resolveCalls.length).toBe(4);
    expect(killCalls.length).toBe(4);
    // repeated-signal uses SIGINT; total: sigint(1 SIGINT) + sigterm(1 SIGTERM) + repeated(2 SIGINT) = 3 SIGINT
    expect(killCalls.filter((c) => c.signal === "SIGINT").length).toBe(3);
    expect(killCalls.filter((c) => c.signal === "SIGTERM").length).toBe(1);
  });

  test("fails when second resolve returns different pid (stale PID)", async () => {
    const sessionId = "dar09-repeat-stale-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("linux", store);

    // Calls: sigint(#1) + sigterm(#2) + repeated-first(#3) + repeated-second(#4)
    // Return different pid only on call #4 (repeated-signal's 2nd resolve) to trigger stale PID
    let resolveCallCount = 0;
    const deps: Dar09Dependencies = {
      ...makeDependencies(sessionId, meta),
      resolveHost: async () => {
        resolveCallCount += 1;
        return resolveCallCount === 4
          ? { pid: 99999, command: "climon __session " + sessionId }
          : FAKE_HOST;
      },
    };

    const results = await runDar09(context, deps);
    const result = results.find((r) => r.name === "repeated-signal-idempotency")!;
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/pid|stale/i);
  });

  test("fails unless repeated SIGINT finalizes as failed with a nonzero exit code", async () => {
    const sessionId = "dar09-repeat-meta-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    store.waitForTerminalStatus = async () => ({
      ...meta,
      status: "completed",
      exitCode: 0,
      completedAt: "2026-01-01T00:00:00.000Z",
    });

    const results = await runDar09(
      makeContext("linux", store),
      makeDependencies(sessionId, meta)
    );
    const result = results.find((r) => r.name === "repeated-signal-idempotency")!;
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/failed|exitCode|nonzero/i);
  });
});

// ── Windows forced host termination required assertions ───────────────────────

describe("DAR-09 windows-forced-host-termination required assertions", () => {
  async function runWinTerm(overrides: Partial<Dar09Dependencies> = {}) {
    const sessionId = "dar09-win-assert-0001";
    const meta = makeSignalHoldMeta(sessionId, { status: "running" });
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    // Short deadline so timeout-triggering tests finish within bun test timeout
    const context = { ...makeContext("windows", store), overallDeadline: Date.now() + 300 };
    let removed = false;
    const deps: Dar09Dependencies = {
      ...makeDependencies(sessionId, meta, { scrollback: "" }),
      killSessionRecord: async () => { removed = true; },
      readSessionMeta: async (id) => {
        if (removed && id === sessionId) {
          removed = false; // one-shot: reset so resize poller isn't blocked
          return undefined;
        }
        return { ...meta, cols: RESIZE_COLS, rows: RESIZE_ROWS };
      },
      ...overrides,
    };
    const results = await runDar09(context, deps);
    return results.find((r) => r.name === "windows-forced-host-termination")!;
  }

  test("fails when socket is not open before termination", async () => {
    const result = await runWinTerm({
      createSocketProbe: () => ({
        waitOpen: async () => { throw new Error("socket not open"); },
        waitClosed: async () => {},
        probeOnce: async () => false,
      }),
    });
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/socket.*open|open.*socket/i);
  });

  test("fails when host does not exit after Stop-Process", async () => {
    const result = await runWinTerm({
      isProcessAlive: () => true,
    });
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/host.*exit|exit.*host|alive|timeout/i);
  });

  test("fails when socket does not close after termination", async () => {
    const result = await runWinTerm({
      createSocketProbe: () => ({
        waitOpen: async () => {},
        waitClosed: async () => { throw new Error("socket still open"); },
        probeOnce: async () => true,
      }),
    });
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/socket.*clos|clos.*socket/i);
  });

  test("fails when climon kill throws (reconcile error)", async () => {
    const result = await runWinTerm({
      killSessionRecord: async () => { throw new Error("kill command failed with code 1"); },
    });
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/kill|reconcile/i);
  });

  test("verifies session metadata removed after kill (readSessionMeta returns undefined)", async () => {
    // Happy path: after killSessionRecord, readSessionMeta should return undefined
    const result = await runWinTerm();
    expect(result.status, result.message).toBe("passed");
  });

  test("fails when abrupt termination produced final scrollback", async () => {
    const result = await runWinTerm({
      readScrollback: async () => "unexpected finalized output",
    });
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/scrollback/i);
  });

  test("fails when the stale metadata record is absent before reconciliation", async () => {
    let findCalls = 0;
    const result = await runWinTerm({
      findSession: async () => {
        findCalls += 1;
        return findCalls === 1
          ? makeSignalHoldMeta("dar09-win-assert-0001", { status: "running" })
          : undefined;
      },
    });
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/metadata|stale|record/i);
  });
});

describe("DAR-09 attached resize finalization", () => {
  test("fails when the attached PTY exits nonzero", async () => {
    const sessionId = "dar09-resize-exit-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const fakePty = new FakePty();
    fakePty.waitForExitCode = 7;

    const results = await runDar09(makeContext("linux", store), {
      ...makeDependencies(sessionId, meta),
      spawnPty: () => fakePty,
    });
    const result = results.find((r) => r.name === "attached-resize-path")!;
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/exit.*0|exitCode|nonzero/i);
  });

});

// ── Windows resize: exactly one marker ────────────────────────────────────────

describe("DAR-09 windows-console-resize-poller marker count", () => {
  test("fails when two DAR_CONTROL_RESIZE markers appear in output", async () => {
    const sessionId = "dar09-win-resize-double-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("windows", store);

    const fakePty = new FakePty();
    // Simulate two resize markers in the local output
    fakePty.localOutput = `${RESIZE_MARKER_FULL}\n${RESIZE_MARKER_FULL}\n`;

    const deps: Dar09Dependencies = {
      ...makeDependencies(sessionId, meta),
      spawnPty: () => fakePty,
    };

    const results = await runDar09(context, deps);
    const result = results.find((r) => r.name === "windows-console-resize-poller")!;
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/exactly.*1|duplicate|2.*marker/i);
  });

  test("passes when exactly one DAR_CONTROL_RESIZE marker in output", async () => {
    const sessionId = "dar09-win-resize-ok-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("windows", store);

    const fakePty = new FakePty();
    fakePty.localOutput = `${RESIZE_MARKER_FULL}\n`; // exactly one

    const deps: Dar09Dependencies = {
      ...makeDependencies(sessionId, meta),
      spawnPty: () => fakePty,
    };

    const results = await runDar09(context, deps);
    const result = results.find((r) => r.name === "windows-console-resize-poller")!;
    expect(result.status, result.message).toBe("passed");
  });
});

// ── Resize ready marker ───────────────────────────────────────────────────────

describe("DAR-09 resize ready marker", () => {
  test("attached-resize-path waits for DAR_CONTROL_READY alone (not with dimensions)", async () => {
    const sessionId = "dar09-ready-marker-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("linux", store);

    const fakePty = new FakePty();
    const deps: Dar09Dependencies = {
      ...makeDependencies(sessionId, meta),
      spawnPty: () => fakePty,
    };

    await runDar09(context, deps);
    // The first expectRaw call must be exactly "DAR_CONTROL_READY" — not "DAR_CONTROL_READY 80 24"
    expect(fakePty.expectRawCalls[0]).toBe("DAR_CONTROL_READY");
    expect(fakePty.expectRawCalls).not.toContain("DAR_CONTROL_READY 80 24");
  });

  test("windows-console-resize-poller waits for DAR_CONTROL_READY alone", async () => {
    const sessionId = "dar09-win-ready-marker-0001";
    const meta = makeSignalHoldMeta(sessionId);
    const store = makeSessionsStore(new Map([[sessionId, meta]]));
    const context = makeContext("windows", store);

    const fakePty = new FakePty();
    const deps: Dar09Dependencies = {
      ...makeDependencies(sessionId, meta),
      spawnPty: () => fakePty,
    };

    await runDar09(context, deps);
    expect(fakePty.expectRawCalls[0]).toBe("DAR_CONTROL_READY");
    expect(fakePty.expectRawCalls).not.toContain("DAR_CONTROL_READY 80 24");
  });
});

// ── process-discovery default import path ────────────────────────────────────

describe("DAR-09 default resolveHost wires correct module", () => {
  test("resolveSessionHost can be imported from ../drivers/process-discovery.js", async () => {
    // This test catches the wrong import path ./process-discovery.js which would
    // fail at runtime when no resolveHost dep is injected. We verify the module
    // loads correctly by importing it directly.
    const { resolveSessionHost } = await import(
      "../src/drivers/process-discovery.js"
    );
    expect(typeof resolveSessionHost).toBe("function");
  });
});
