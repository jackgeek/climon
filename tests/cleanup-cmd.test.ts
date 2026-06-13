import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeServerState } from "../src/server-state.js";
import { serializeIngestState } from "../src/remote/ingest-state.js";
import { teardownLocalServerStack } from "../src/remote/teardown.js";
import { runCleanupCommand } from "../src/cli/cleanup-cmd.js";
import { initLogger, resetLoggerForTests } from "../src/logging/logger.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  const testTmp = join(process.cwd(), ".copilot-tmp");
  mkdirSync(testTmp, { recursive: true });
  home = mkdtempSync(join(testTmp, "climon-cleanup-"));
  env = { CLIMON_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seedStack(): void {
  writeFileSync(join(home, "server.json"), serializeServerState({ pid: 111, port: 3131, ingest: 3132 }));
  writeFileSync(join(home, "ingest.json"), serializeIngestState({ pid: 222, port: 3132 }));
  writeFileSync(join(home, "ingest.pid"), "222\n");
  writeFileSync(join(home, "uplink.pid"), "333\n");
  writeFileSync(
    join(home, "shutdown-request.json"),
    `${JSON.stringify({ requestedBy: "Windows", ts: Date.now() })}\n`
  );
}

/** Creates mocks where processes die immediately after being killed. */
function mockKillSucceeds() {
  const killed = new Set<number>();
  return {
    killed,
    isProcessAlive: (pid: number) => !killed.has(pid),
    killProcess: (pid: number) => { killed.add(pid); return true; }
  };
}

describe("teardownLocalServerStack", () => {
  test("kills server, ingest, uplink and removes all beacons", async () => {
    seedStack();
    const { killed, isProcessAlive, killProcess } = mockKillSucceeds();
    const report = await teardownLocalServerStack({
      env, isProcessAlive, killProcess
    });
    expect([...killed].sort()).toEqual([111, 222, 333]);
    expect(report.serverStopped).toBe(true);
    expect(report.ingestStopped).toBe(true);
    expect(report.uplinkStopped).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.staleFiles).toEqual([]);
    expect(existsSync(join(home, "server.json"))).toBe(false);
    expect(existsSync(join(home, "ingest.json"))).toBe(false);
    expect(existsSync(join(home, "ingest.pid"))).toBe(false);
    expect(existsSync(join(home, "uplink.pid"))).toBe(false);
    expect(existsSync(join(home, "shutdown-request.json"))).toBe(false);
  });

  test("is idempotent when nothing is running", async () => {
    const report = await teardownLocalServerStack({
      env,
      isProcessAlive: () => false,
      killProcess: () => false
    });
    expect(report.serverStopped).toBe(false);
    expect(report.ingestStopped).toBe(false);
    expect(report.uplinkStopped).toBe(false);
    expect(report.removed).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.staleFiles).toEqual([]);
  });

  test("reports failures and stale files when kill does not terminate", async () => {
    seedStack();
    // killProcess returns true (signal sent) but process never dies
    const report = await teardownLocalServerStack({
      env,
      isProcessAlive: () => true,
      killProcess: () => true,
      waitTimeoutMs: 200
    });
    expect(report.serverStopped).toBe(false);
    expect(report.ingestStopped).toBe(false);
    expect(report.uplinkStopped).toBe(false);
    expect(report.failures.length).toBe(3);
    expect(report.failures[0].component).toBe("dashboard server");
    expect(report.failures[0].pid).toBe(111);
    // Beacon files should NOT be removed when processes are still alive
    expect(report.staleFiles.length).toBeGreaterThan(0);
    expect(existsSync(join(home, "server.json"))).toBe(true);
  });

  test("does not remove beacon when kill signal cannot be sent", async () => {
    seedStack();
    // killProcess returns false (signal cannot be sent) but process is alive
    const report = await teardownLocalServerStack({
      env,
      isProcessAlive: () => true,
      killProcess: () => false,
      waitTimeoutMs: 200
    });
    expect(report.serverStopped).toBe(false);
    expect(report.ingestStopped).toBe(false);
    expect(report.uplinkStopped).toBe(false);
    expect(report.failures.length).toBe(3);
    // All beacon files should still exist
    expect(existsSync(join(home, "server.json"))).toBe(true);
    expect(existsSync(join(home, "ingest.pid"))).toBe(true);
    expect(existsSync(join(home, "uplink.pid"))).toBe(true);
    expect(report.staleFiles.length).toBeGreaterThan(0);
  });
});

describe("teardownLocalServerStack logging", () => {
  function captureLog(): { records: () => Array<Record<string, unknown>>; stream: NodeJS.WritableStream } {
    const lines: string[] = [];
    const stream = {
      write(chunk: string) {
        lines.push(chunk);
        return true;
      }
    } as unknown as NodeJS.WritableStream;
    const records = () =>
      lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { records, stream };
  }

  test("emits structured teardown lifecycle logs tagged with the teardown component", async () => {
    seedStack();
    const { records, stream } = captureLog();
    resetLoggerForTests();
    // Use a non-terminal role so no pretty stream prints to stdout during the test.
    initLogger("ingest", { level: "debug", env, extraStreams: [{ stream, level: "debug" }] });
    try {
      const { isProcessAlive, killProcess } = mockKillSucceeds();
      await teardownLocalServerStack({ env, isProcessAlive, killProcess });
    } finally {
      resetLoggerForTests();
    }

    const recs = records();
    const messages = recs.map((r) => r.msg);
    expect(messages).toContain("starting local dashboard stack teardown");
    expect(messages).toContain("local dashboard stack teardown complete");
    expect(recs.some((r) => r.msg === "removed beacon" && typeof r.path === "string")).toBe(true);
    // Every teardown record keeps the component binding (no field collisions).
    expect(recs.every((r) => r.component === "teardown")).toBe(true);
  });

  test("logs a warning per daemon that cannot be stopped", async () => {
    seedStack();
    const { records, stream } = captureLog();
    resetLoggerForTests();
    initLogger("ingest", { level: "debug", env, extraStreams: [{ stream, level: "debug" }] });
    try {
      await teardownLocalServerStack({
        env,
        isProcessAlive: () => true,
        killProcess: () => true,
        waitTimeoutMs: 100
      });
    } finally {
      resetLoggerForTests();
    }

    const warnings = records().filter(
      (r) => r.level === 40 && r.msg === "failed to stop daemon during teardown"
    );
    expect(warnings.length).toBe(3);
    expect(warnings.every((r) => r.component === "teardown" && typeof r.daemon === "string" && r.reason)).toBe(true);
  });
});

describe("runCleanupCommand", () => {
  test("reports what it stopped and removed", async () => {
    seedStack();
    const { isProcessAlive, killProcess } = mockKillSucceeds();
    const out: string[] = [];
    const code = await runCleanupCommand({
      env, isProcessAlive, killProcess,
      stdout: (chunk) => out.push(chunk)
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("Stopped dashboard server");
    expect(text).toContain("Stopped ingest");
    expect(text).toContain("Stopped uplink");
    expect(text).toContain("Removed");
    expect(text).toContain("server.json");
  });

  test("reports removed stale files when no daemons are running", async () => {
    writeFileSync(join(home, "server.json"), serializeServerState({ pid: 111, port: 3131, ingest: 3132 }));
    const out: string[] = [];
    const code = await runCleanupCommand({
      env,
      isProcessAlive: () => false,
      killProcess: () => false,
      stdout: (chunk) => out.push(chunk)
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("Removed");
    expect(text).toContain("server.json");
    expect(text).not.toContain("Nothing to clean up");
  });

  test("succeeds and reports a clean state when nothing is running and no stale files", async () => {
    const out: string[] = [];
    const code = await runCleanupCommand({
      env,
      isProcessAlive: () => false,
      killProcess: () => false,
      stdout: (chunk) => out.push(chunk)
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("Nothing to clean up");
  });

  test("returns exit code 1 and prints warnings when kills fail", async () => {
    seedStack();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCleanupCommand({
      env,
      isProcessAlive: () => true,
      killProcess: () => true,
      stdout: (chunk) => out.push(chunk),
      stderr: (chunk) => err.push(chunk),
      waitTimeoutMs: 200
    });
    expect(code).toBe(1);
    const errText = err.join("");
    expect(errText).toContain("WARNING");
    expect(errText).toContain("dashboard server");
    expect(errText).toContain("Cannot remove");
  });
});