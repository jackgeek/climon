import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveIngestRetryAttempts } from "../src/remote/ingest.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  const testTmp = join(process.cwd(), ".copilot-tmp");
  mkdirSync(testTmp, { recursive: true });
  home = mkdtempSync(join(testTmp, "climon-ingest-retry-"));
  env = { CLIMON_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeGlobalConfig(value: unknown): void {
  mkdirSync(join(home), { recursive: true });
  writeFileSync(join(home, "config.jsonc"), JSON.stringify({ remote: { ingestPortRetryAttempts: value } }));
}

describe("resolveIngestRetryAttempts", () => {
  test("defaults to 100 when unset", () => {
    expect(resolveIngestRetryAttempts(env)).toBe(100);
  });

  test("uses a valid configured value", () => {
    writeGlobalConfig(250);
    expect(resolveIngestRetryAttempts(env)).toBe(250);
  });

  test("falls back to 100 for invalid values", () => {
    writeGlobalConfig(0);
    expect(resolveIngestRetryAttempts(env)).toBe(100);
    writeGlobalConfig(-3);
    expect(resolveIngestRetryAttempts(env)).toBe(100);
  });
});