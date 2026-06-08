import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverDashboard } from "../src/remote/discovery.js";
import { writeIngestState } from "../src/remote/ingest-state.js";
import { serializeServerState } from "../src/server-state.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  const testTmp = join(process.cwd(), ".copilot-tmp");
  mkdirSync(testTmp, { recursive: true });
  home = mkdtempSync(join(testTmp, "climon-resolve-port-"));
  env = { CLIMON_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("local ingest port resolution in discovery", () => {
  test("returns the shifted ingest.json port, not the 3132 default or a stale server.json value", async () => {
    // server.json claims the default ingest port; the live ingest actually shifted to 3140.
    writeFileSync(
      join(home, "server.json"),
      serializeServerState({ pid: process.pid, port: 3131, ingest: 3132 })
    );
    await writeIngestState({ pid: process.pid, port: 3140 }, env);

    const target = await discoverDashboard(env, process.cwd(), { isAlive: () => true });
    expect(target?.location).toBe("local");
    expect(target?.ingest).toBe(3140);
  });
});
