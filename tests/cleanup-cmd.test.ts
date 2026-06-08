import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeServerState } from "../src/server-state.js";
import { serializeIngestState } from "../src/remote/ingest-state.js";
import { teardownLocalServerStack } from "../src/remote/teardown.js";
import { runCleanupCommand } from "../src/cli/cleanup-cmd.js";

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

describe("teardownLocalServerStack", () => {
  test("kills server, ingest, uplink and removes all beacons", async () => {
    seedStack();
    const killed: number[] = [];
    const report = await teardownLocalServerStack({
      env,
      isProcessAlive: () => true,
      killProcess: (pid) => { killed.push(pid); return true; }
    });
    expect(killed.sort()).toEqual([111, 222, 333]);
    expect(report.serverStopped).toBe(true);
    expect(report.ingestStopped).toBe(true);
    expect(report.uplinkStopped).toBe(true);
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
  });
});

describe("runCleanupCommand", () => {
  test("reports what it stopped and removed", async () => {
    seedStack();
    const out: string[] = [];
    const code = await runCleanupCommand({
      env,
      isProcessAlive: () => true,
      killProcess: () => true,
      stdout: (chunk) => out.push(chunk)
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("Stopped dashboard server");
    expect(text).toContain("Stopped ingest");
    expect(text).toContain("Stopped uplink");
  });

  test("succeeds and reports a clean state when nothing is running", async () => {
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
});