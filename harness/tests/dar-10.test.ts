import { describe, expect, test } from "bun:test";

import {
  DAR_10_SUBCHECKS,
  DAR_10_SUBCHECK_NAMES,
  runDar10,
  type Dar10Context,
  type Dar10Dependencies,
  type Dar10Pty,
} from "../src/scenarios/dar-10.js";
import type { SessionStatus } from "../src/session-ledger.js";

// ── Expected subcheck contract ────────────────────────────────────────────────

const EXPECTED_NAMES = [
  "default-legacy-engine",
  "explicit-actor-engine",
  "explicit-legacy-rollback",
  "external-parity",
  "invalid-attached-diagnostic",
  "invalid-headless-diagnostic",
  "no-daemon-start",
] as const;

const EXPECTED_TITLES: Record<(typeof EXPECTED_NAMES)[number], string> = {
  "default-legacy-engine":
    "Default engine (CLIMON_SESSION_ENGINE unset) is legacy: DAR_ENGINE_ECHO marker in output, status=completed, exitCode=0, nonempty completedAt",
  "explicit-actor-engine":
    "Explicit actor engine (CLIMON_SESSION_ENGINE=actor): DAR_ENGINE_ECHO marker in output, status=completed, exitCode=0, nonempty completedAt",
  "explicit-legacy-rollback":
    "Explicit legacy rollback (CLIMON_SESSION_ENGINE=legacy): DAR_ENGINE_ECHO marker in output, status=completed, exitCode=0, nonempty completedAt",
  "external-parity":
    "Default, actor, and legacy sessions show identical normalized output, status=completed, exitCode=0, and DAR_ENGINE_ECHO in final scrollback",
  "invalid-attached-diagnostic":
    "Invalid CLIMON_SESSION_ENGINE=future surfaces exact diagnostic to attached terminal and exits nonzero",
  "invalid-headless-diagnostic":
    "Invalid CLIMON_SESSION_ENGINE=future in headless session writes exact diagnostic to sessions/<id>.log before daemon logger initializes",
  "no-daemon-start":
    "Invalid headless engine selection prevents daemon start: no daemon log, no live socket, no live daemon host",
};

// ── Test constants ────────────────────────────────────────────────────────────

const RUN_ID = "dar10run-0001-0000-0000-000000000000";
const FAKE_NOW = 1_700_000_000_000;
const FAR_DEADLINE = FAKE_NOW + 10_000_000;

const DEFAULT_SESSION_ID = "dar-10-default-session";
const ACTOR_SESSION_ID = "dar-10-actor-session";
const LEGACY_SESSION_ID = "dar-10-legacy-session";
const INVALID_HEADLESS_SESSION_ID = "dar10-invalid-hs";

const ENGINE_ECHO_SCROLLBACK = "DAR_ENGINE_ECHO\nsome other output\n";
const INVALID_DIAGNOSTIC = "invalid CLIMON_SESSION_ENGINE 'future'; expected 'legacy' or 'actor'";

// ── Fake types ────────────────────────────────────────────────────────────────

interface FakeSessionMeta extends Record<string, unknown> {
  id: string;
  name: string;
  status: SessionStatus;
  exitCode?: number;
  completedAt?: string;
  socketPath?: string;
}

interface ScenarioState {
  defaultMeta: FakeSessionMeta;
  actorMeta: FakeSessionMeta;
  legacyMeta: FakeSessionMeta;
  defaultScrollback: string;
  actorScrollback: string;
  legacyScrollback: string;
  trackedIds: string[];
  /** session log for invalid headless (sessions/<id>.log) */
  sessionLog: string;
  /** daemon log for invalid headless (logs/daemon/<id>.log) — undefined = absent */
  daemonLog: string | undefined;
  /** Whether resolveHost should throw (no host found) */
  noHostFound: boolean;
  resolveHostError?: Error;
  killError?: Error;
  resolvedPlatforms: string[];
  invalidSocketPath?: string;
  socketOpen: boolean;
}

function makeCompletedMeta(id: string, name: string): FakeSessionMeta {
  return {
    id,
    name,
    status: "completed",
    exitCode: 0,
    completedAt: "2026-01-01T00:00:00.000Z",
    socketPath: `unix:///fake/${id}.sock`,
  };
}

function makeState(overrides: Partial<ScenarioState> = {}): ScenarioState {
  return {
    defaultMeta: makeCompletedMeta(DEFAULT_SESSION_ID, `DAR-10-default-${RUN_ID.slice(0, 8)}`),
    actorMeta: makeCompletedMeta(ACTOR_SESSION_ID, `DAR-10-actor-${RUN_ID.slice(0, 8)}`),
    legacyMeta: makeCompletedMeta(LEGACY_SESSION_ID, `DAR-10-legacy-${RUN_ID.slice(0, 8)}`),
    defaultScrollback: ENGINE_ECHO_SCROLLBACK,
    actorScrollback: ENGINE_ECHO_SCROLLBACK,
    legacyScrollback: ENGINE_ECHO_SCROLLBACK,
    trackedIds: [],
    sessionLog: INVALID_DIAGNOSTIC,
    daemonLog: undefined,
    noHostFound: true,
    resolvedPlatforms: [],
    invalidSocketPath: "tcp://127.0.0.1:0",
    socketOpen: false,
    ...overrides,
  };
}

// ── Fake PTY ──────────────────────────────────────────────────────────────────

class FakePty implements Dar10Pty {
  public expectRawCalls: string[] = [];
  public exitCode: number;
  public expectRawError?: Error;

  public constructor(exitCode = 0) {
    this.exitCode = exitCode;
  }

  public async expectRaw(marker: string, _deadline: number): Promise<void> {
    this.expectRawCalls.push(marker);
    if (this.expectRawError) throw this.expectRawError;
  }

  public async waitForExit(_deadline: number): Promise<number> {
    return this.exitCode;
  }

  public kill(): void {}

  public readLocalOutput(): string {
    return this.expectRawCalls.join("\n");
  }
}

// ── Context and dependency factories ─────────────────────────────────────────

function makeContext(state: ScenarioState): Dar10Context {
  return {
    platform: "macos",
    overallDeadline: FAR_DEADLINE,
    build: {
      clientPath: "/fake/climon",
      fixturePath: "/fake/climon-harness-fixture",
    },
    runtime: {
      root: "/fake/root",
      home: "/fake/home",
      env: { PATH: "/usr/bin:/bin" },
      artifacts: {
        dir: "/fake/artifacts",
        appendText: async (_relPath: string, _text: string) => {},
      },
      sessions: {
        track(id: string) {
          state.trackedIds.push(id);
        },
        async waitForTerminalStatus(id: string, _deadline: number) {
          const meta = [state.defaultMeta, state.actorMeta, state.legacyMeta].find(
            (m) => m.id === id
          );
          if (!meta) throw new Error(`Unknown id: ${id}`);
          return meta;
        },
        async read(id: string) {
          const meta = [state.defaultMeta, state.actorMeta, state.legacyMeta].find(
            (m) => m.id === id
          );
          if (!meta) throw new Error(`Unknown id: ${id}`);
          return meta;
        },
      },
    },
  };
}

type PtyVariant = "default" | "actor" | "legacy" | "invalid-attached";

function makeDependencies(
  state: ScenarioState,
  ptyMap: Map<PtyVariant, FakePty>,
  ptyCallOrder: PtyVariant[]
): Dar10Dependencies {
  // Advance now by 1000ms per call so waitForValue deadline checks fire within
  // ~30 iterations when the session log or session is absent (failure tests).
  // In success cases, producer() returns on the first call so the deadline is
  // never reached regardless.
  let nowValue = FAKE_NOW;
  const now = (): number => {
    nowValue += 1_000;
    return nowValue;
  };
  return {
    now,
    sleep: async () => {},
    pollIntervalMs: 1,
    createUuid: () => RUN_ID,
    spawnPty: (spec, _deps) => {
      // Determine variant by env
      const engine = spec.env?.CLIMON_SESSION_ENGINE;
      let variant: PtyVariant;
      if (engine === "actor") variant = "actor";
      else if (engine === "legacy") variant = "legacy";
      else if (engine === "future") variant = "invalid-attached";
      else variant = "default";
      ptyCallOrder.push(variant);
      return ptyMap.get(variant) ?? new FakePty();
    },
    findSession: async (opts) => {
      if (opts.expectedName.includes("default")) return state.defaultMeta;
      if (opts.expectedName.includes("actor")) return state.actorMeta;
      if (opts.expectedName.includes("legacy")) return state.legacyMeta;
      return undefined;
    },
    readScrollback: async (_home, id) => {
      if (id === DEFAULT_SESSION_ID) return state.defaultScrollback;
      if (id === ACTOR_SESSION_ID) return state.actorScrollback;
      if (id === LEGACY_SESSION_ID) return state.legacyScrollback;
      return "";
    },
    runCommand: async (spec) => {
      const engineVal = spec.env?.CLIMON_SESSION_ENGINE;
      if (engineVal === "future") {
        return {
          code: 0,
          stdout: `${INVALID_HEADLESS_SESSION_ID}\n`,
          stderr: "",
          durationMs: 0,
        };
      }
      return { code: 0, stdout: "", stderr: "", durationMs: 0 };
    },
    readSessionLog: async (_home, id) => {
      if (id === INVALID_HEADLESS_SESSION_ID) return state.sessionLog;
      return undefined;
    },
    readDaemonLog: async (_home, id) => {
      if (id === INVALID_HEADLESS_SESSION_ID) return state.daemonLog;
      return undefined;
    },
    readSessionMeta: async (_home, id) =>
      id === INVALID_HEADLESS_SESSION_ID
        ? {
            id,
            name: "invalid-headless",
            status: "running",
            socketPath: state.invalidSocketPath,
          }
        : undefined,
    isSocketOpen: async () => state.socketOpen,
    resolveHost: async (_platform, _sessionId, _opts) => {
      state.resolvedPlatforms.push(_platform);
      if (state.resolveHostError) throw state.resolveHostError;
      if (state.noHostFound) {
        return undefined;
      }
      return { pid: 12345, command: "fake" };
    },
    cleanupInvalidSession: async () => {
      if (state.killError) throw state.killError;
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DAR-10 subcheck contract", () => {
  test("exports correct subcheck names array", () => {
    expect(DAR_10_SUBCHECK_NAMES).toEqual(EXPECTED_NAMES);
  });

  test("exports subchecks with correct names and titles", () => {
    for (const subcheck of DAR_10_SUBCHECKS) {
      expect(EXPECTED_TITLES[subcheck.name as (typeof EXPECTED_NAMES)[number]]).toBe(
        subcheck.title
      );
    }
    expect(DAR_10_SUBCHECKS).toHaveLength(EXPECTED_NAMES.length);
  });
});

describe("DAR-10 happy path", () => {
  test("all subchecks pass for default/actor/legacy engine runs", async () => {
    const state = makeState();
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", new FakePty(0)],
      ["actor", new FakePty(0)],
      ["legacy", new FakePty(0)],
      ["invalid-attached", new FakePty(1)], // nonzero exit for invalid engine
    ]);
    const ptyCallOrder: PtyVariant[] = [];

    const context = makeContext(state);
    const deps = makeDependencies(state, ptyMap, ptyCallOrder);

    const results = await runDar10(context, deps);

    expect(results).toHaveLength(EXPECTED_NAMES.length);

    const byName = new Map(results.map((r) => [r.name, r]));

    for (const name of EXPECTED_NAMES) {
      const r = byName.get(name);
      expect(r, `subcheck ${name} missing`).toBeDefined();
      expect(r!.status, `subcheck ${name} status`).toBe("passed");
    }

    // PTYs were spawned for all three valid variants
    expect(ptyCallOrder).toContain("default");
    expect(ptyCallOrder).toContain("actor");
    expect(ptyCallOrder).toContain("legacy");

    // All three valid sessions were tracked
    expect(state.trackedIds).toContain(DEFAULT_SESSION_ID);
    expect(state.trackedIds).toContain(ACTOR_SESSION_ID);
    expect(state.trackedIds).toContain(LEGACY_SESSION_ID);
  });

  test("valid PTYs receive expectRaw for DAR_ENGINE_ECHO marker", async () => {
    const state = makeState();
    const defaultPty = new FakePty(0);
    const actorPty = new FakePty(0);
    const legacyPty = new FakePty(0);
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", defaultPty],
      ["actor", actorPty],
      ["legacy", legacyPty],
      ["invalid-attached", new FakePty(1)],
    ]);

    const context = makeContext(state);
    const deps = makeDependencies(state, ptyMap, []);

    await runDar10(context, deps);

    expect(defaultPty.expectRawCalls).toContain("DAR_ENGINE_ECHO");
    expect(actorPty.expectRawCalls).toContain("DAR_ENGINE_ECHO");
    expect(legacyPty.expectRawCalls).toContain("DAR_ENGINE_ECHO");
  });
});

describe("DAR-10 default-legacy-engine subcheck", () => {
  test("fails when scrollback does not contain DAR_ENGINE_ECHO", async () => {
    const state = makeState({ defaultScrollback: "some output without marker\n" });
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", new FakePty(0)],
      ["actor", new FakePty(0)],
      ["legacy", new FakePty(0)],
    ]);

    const context = makeContext(state);
    const deps = makeDependencies(state, ptyMap, []);

    const results = await runDar10(context, deps);
    const byName = new Map(results.map((r) => [r.name, r]));

    expect(byName.get("default-legacy-engine")!.status).toBe("failed");
  });

  test("fails when session exitCode is nonzero", async () => {
    const state = makeState({
      defaultMeta: { ...makeCompletedMeta(DEFAULT_SESSION_ID, "x"), exitCode: 1 },
    });
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", new FakePty(0)],
      ["actor", new FakePty(0)],
      ["legacy", new FakePty(0)],
    ]);

    const context = makeContext(state);
    const deps = makeDependencies(state, ptyMap, []);

    const results = await runDar10(context, deps);
    const byName = new Map(results.map((r) => [r.name, r]));

    expect(byName.get("default-legacy-engine")!.status).toBe("failed");
  });
});

describe("DAR-10 external-parity subcheck", () => {
  test("fails when default and actor scrollbacks differ", async () => {
    const state = makeState({ actorScrollback: "DAR_ENGINE_ECHO\ndifferent output\n" });
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", new FakePty(0)],
      ["actor", new FakePty(0)],
      ["legacy", new FakePty(0)],
    ]);

    const context = makeContext(state);
    const deps = makeDependencies(state, ptyMap, []);

    const results = await runDar10(context, deps);
    const byName = new Map(results.map((r) => [r.name, r]));

    expect(byName.get("external-parity")!.status).toBe("failed");
  });
});

describe("DAR-10 invalid-attached-diagnostic subcheck", () => {
  test("passes when PTY shows exact diagnostic and exits nonzero", async () => {
    const state = makeState();
    const invalidPty = new FakePty(1); // nonzero exit
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", new FakePty(0)],
      ["actor", new FakePty(0)],
      ["legacy", new FakePty(0)],
      ["invalid-attached", invalidPty],
    ]);

    const context = makeContext(state);
    const deps = makeDependencies(state, ptyMap, []);

    const results = await runDar10(context, deps);
    const byName = new Map(results.map((r) => [r.name, r]));

    expect(byName.get("invalid-attached-diagnostic")!.status).toBe("passed");
    expect(invalidPty.expectRawCalls).toContain(INVALID_DIAGNOSTIC);
  });

  test("fails when the exact diagnostic is not visible in the PTY", async () => {
    const state = makeState();
    const invalidPty = new FakePty(1);
    invalidPty.expectRawError = new Error("timeout waiting for diagnostic");
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", new FakePty(0)],
      ["actor", new FakePty(0)],
      ["legacy", new FakePty(0)],
      ["invalid-attached", invalidPty],
    ]);

    const results = await runDar10(
      makeContext(state),
      makeDependencies(state, ptyMap, [])
    );
    const byName = new Map(results.map((r) => [r.name, r]));

    expect(byName.get("invalid-attached-diagnostic")!.status).toBe("failed");
    expect(byName.get("invalid-attached-diagnostic")!.message).toContain(
      "Exact diagnostic not visible in PTY"
    );
  });

  test("fails when PTY exits with code 0 (diagnostic not surfaced)", async () => {
    const state = makeState();
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", new FakePty(0)],
      ["actor", new FakePty(0)],
      ["legacy", new FakePty(0)],
      ["invalid-attached", new FakePty(0)], // zero exit — wrong
    ]);

    const context = makeContext(state);
    const deps = makeDependencies(state, ptyMap, []);

    const results = await runDar10(context, deps);
    const byName = new Map(results.map((r) => [r.name, r]));

    expect(byName.get("invalid-attached-diagnostic")!.status).toBe("failed");
  });
});

describe("DAR-10 invalid-headless-diagnostic subcheck", () => {
  test("passes when sessions/<id>.log contains exact diagnostic", async () => {
    const state = makeState({ sessionLog: INVALID_DIAGNOSTIC });
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", new FakePty(0)],
      ["actor", new FakePty(0)],
      ["legacy", new FakePty(0)],
    ]);

    const context = makeContext(state);
    const deps = makeDependencies(state, ptyMap, []);

    const results = await runDar10(context, deps);
    const byName = new Map(results.map((r) => [r.name, r]));

    expect(byName.get("invalid-headless-diagnostic")!.status).toBe("passed");
  });

  test("fails when sessions/<id>.log does not contain the exact diagnostic text", async () => {
    const state = makeState({ sessionLog: "some other error message" });
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", new FakePty(0)],
      ["actor", new FakePty(0)],
      ["legacy", new FakePty(0)],
    ]);

    const context = makeContext(state);
    const deps = makeDependencies(state, ptyMap, []);

    const results = await runDar10(context, deps);
    const byName = new Map(results.map((r) => [r.name, r]));

    expect(byName.get("invalid-headless-diagnostic")!.status).toBe("failed");
  });

  test("fails when sessions/<id>.log is absent", async () => {
    const state = makeState({ sessionLog: "" });
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", new FakePty(0)],
      ["actor", new FakePty(0)],
      ["legacy", new FakePty(0)],
    ]);

    const context = makeContext(state);
    // Override readSessionLog to return undefined
    const deps: Dar10Dependencies = {
      ...makeDependencies(state, ptyMap, []),
      readSessionLog: async () => undefined,
    };

    const results = await runDar10(context, deps);
    const byName = new Map(results.map((r) => [r.name, r]));

    expect(byName.get("invalid-headless-diagnostic")!.status).toBe("failed");
  });
});

describe("DAR-10 no-daemon-start subcheck", () => {
  test("passes when daemon log is absent, no host found, and cleanup succeeds", async () => {
    const state = makeState({ daemonLog: undefined, noHostFound: true });
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", new FakePty(0)],
      ["actor", new FakePty(0)],
      ["legacy", new FakePty(0)],
    ]);

    const context = makeContext(state);
    const deps = makeDependencies(state, ptyMap, []);

    const results = await runDar10(context, deps);
    const byName = new Map(results.map((r) => [r.name, r]));

    expect(byName.get("no-daemon-start")!.status).toBe("passed");
    expect(state.resolvedPlatforms).toEqual(["macos"]);
  });

  test("fails when daemon log is present (daemon started unexpectedly)", async () => {
    const state = makeState({ daemonLog: "daemon started unexpectedly\n" });
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", new FakePty(0)],
      ["actor", new FakePty(0)],
      ["legacy", new FakePty(0)],
    ]);

    const context = makeContext(state);
    const deps = makeDependencies(state, ptyMap, []);

    const results = await runDar10(context, deps);
    const byName = new Map(results.map((r) => [r.name, r]));

    expect(byName.get("no-daemon-start")!.status).toBe("failed");
  });

  test("fails when a host process is found (daemon started unexpectedly)", async () => {
    const state = makeState({ daemonLog: undefined, noHostFound: false });
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", new FakePty(0)],
      ["actor", new FakePty(0)],
      ["legacy", new FakePty(0)],
    ]);

    const context = makeContext(state);
    const deps = makeDependencies(state, ptyMap, []);

    const results = await runDar10(context, deps);
    const byName = new Map(results.map((r) => [r.name, r]));

    expect(byName.get("no-daemon-start")!.status).toBe("failed");
  });

  test("fails when the invalid session published a listening socket", async () => {
    const state = makeState({
      invalidSocketPath: "tcp://127.0.0.1:4242",
      socketOpen: true,
    });
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", new FakePty(0)],
      ["actor", new FakePty(0)],
      ["legacy", new FakePty(0)],
    ]);

    const results = await runDar10(
      makeContext(state),
      makeDependencies(state, ptyMap, [])
    );
    const byName = new Map(results.map((r) => [r.name, r]));

    expect(byName.get("no-daemon-start")!.status).toBe("failed");
    expect(byName.get("no-daemon-start")!.message).toContain(
      "socket is accepting connections"
    );
  });

  test("fails when process discovery itself errors", async () => {
    const state = makeState({
      resolveHostError: new Error("PowerShell process query failed"),
    });
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", new FakePty(0)],
      ["actor", new FakePty(0)],
      ["legacy", new FakePty(0)],
    ]);

    const results = await runDar10(
      makeContext(state),
      makeDependencies(state, ptyMap, [])
    );
    const byName = new Map(results.map((r) => [r.name, r]));

    expect(byName.get("no-daemon-start")!.status).toBe("failed");
    expect(byName.get("no-daemon-start")!.message).toContain(
      "PowerShell process query failed"
    );
  });

  test("fails when stale-record cleanup fails", async () => {
    const state = makeState({ killError: new Error("kill reconciliation failed") });
    const ptyMap = new Map<PtyVariant, FakePty>([
      ["default", new FakePty(0)],
      ["actor", new FakePty(0)],
      ["legacy", new FakePty(0)],
    ]);

    const results = await runDar10(
      makeContext(state),
      makeDependencies(state, ptyMap, [])
    );
    const byName = new Map(results.map((r) => [r.name, r]));

    expect(byName.get("no-daemon-start")!.status).toBe("failed");
    expect(byName.get("no-daemon-start")!.message).toContain(
      "kill reconciliation failed"
    );
  });
});
