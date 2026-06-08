import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  getShutdownRequestPath,
  getShutdownRequestPathInDir,
  MAX_SHUTDOWN_REQUEST_BYTES,
  parseShutdownRequest,
  serializeShutdownRequest,
  writeShutdownRequestToDir,
  type ShutdownRequest
} from "../src/remote/shutdown-request.js";

let home: string;

beforeEach(() => {
  const testTmp = join(process.cwd(), ".copilot-tmp");
  mkdirSync(testTmp, { recursive: true });
  home = mkdtempSync(join(testTmp, "climon-shutdown-request-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const valid: ShutdownRequest = { requestedBy: "Windows", ts: 1717000000000 };

describe("shutdown-request round-trip", () => {
  test("serialize then parse preserves all fields", () => {
    expect(parseShutdownRequest(serializeShutdownRequest(valid))).toEqual(valid);
  });

  test("write then read from a dir returns the same request", async () => {
    await writeShutdownRequestToDir(home, valid);
    const raw = readFileSync(getShutdownRequestPathInDir(home), "utf8");
    expect(parseShutdownRequest(raw)).toEqual(valid);
  });

  test("getShutdownRequestPath is shutdown-request.json under CLIMON_HOME", () => {
    expect(getShutdownRequestPath({ CLIMON_HOME: home } as NodeJS.ProcessEnv)).toBe(
      join(home, "shutdown-request.json")
    );
  });
});

describe("shutdown-request validation (allow-listed, bounded)", () => {
  test("rejects an unknown requestedBy", () => {
    expect(parseShutdownRequest(JSON.stringify({ ...valid, requestedBy: "Linux" }))).toBeUndefined();
  });

  test("rejects a missing requestedBy", () => {
    expect(parseShutdownRequest(JSON.stringify({ ts: 1 }))).toBeUndefined();
  });

  test("rejects a non-positive or non-numeric ts", () => {
    expect(parseShutdownRequest(JSON.stringify({ ...valid, ts: 0 }))).toBeUndefined();
    expect(parseShutdownRequest(JSON.stringify({ ...valid, ts: "soon" }))).toBeUndefined();
  });

  test("rejects an oversized payload before parsing", () => {
    const huge = JSON.stringify({ ...valid, pad: "x".repeat(5000) });
    expect(huge.length).toBeGreaterThan(MAX_SHUTDOWN_REQUEST_BYTES);
    expect(parseShutdownRequest(huge)).toBeUndefined();
  });

  test("rejects non-JSON", () => {
    expect(parseShutdownRequest("not json")).toBeUndefined();
  });
});
