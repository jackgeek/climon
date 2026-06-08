import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getIngestStatePath,
  parseIngestState,
  readIngestStateFromDir,
  resolveIngestPort,
  serializeIngestState,
  writeIngestState,
  type IngestState
} from "../src/remote/ingest-state.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  const testTmp = join(process.cwd(), ".copilot-tmp");
  mkdirSync(testTmp, { recursive: true });
  home = mkdtempSync(join(testTmp, "climon-ingest-state-"));
  env = { CLIMON_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("ingest beacon round-trip", () => {
  test("serialize then parse preserves pid and port", () => {
    const state: IngestState = { pid: 1234, port: 3132 };
    expect(parseIngestState(serializeIngestState(state))).toEqual(state);
  });

  test("write then read from dir returns the same state", async () => {
    const state: IngestState = { pid: 4321, port: 3140 };
    await writeIngestState(state, env);
    expect(await readIngestStateFromDir(home)).toEqual(state);
  });

  test("a tokenless beacon is valid (the token was removed)", () => {
    expect(parseIngestState(JSON.stringify({ pid: 1, port: 3132 }))).toEqual({ pid: 1, port: 3132 });
  });

  test("a leftover shutdownToken field is ignored (backward compatible)", () => {
    expect(parseIngestState(JSON.stringify({ pid: 1, port: 3132, shutdownToken: "old" }))).toEqual({
      pid: 1,
      port: 3132
    });
  });

  test("a malformed pid/port beacon is invalid", () => {
    expect(parseIngestState(JSON.stringify({ pid: 0, port: 3132 }))).toBeUndefined();
    expect(parseIngestState(JSON.stringify({ pid: 1, port: -1 }))).toBeUndefined();
    expect(parseIngestState("not json")).toBeUndefined();
  });

  test("a non-object beacon (null, primitive, array) is invalid without throwing", () => {
    expect(parseIngestState("null")).toBeUndefined();
    expect(parseIngestState("123")).toBeUndefined();
    expect(parseIngestState('"a string"')).toBeUndefined();
    expect(parseIngestState("[1,2,3]")).toBeUndefined();
  });

  test("getIngestStatePath is ingest.json under CLIMON_HOME", () => {
    expect(getIngestStatePath(env)).toBe(join(home, "ingest.json"));
  });
});

describe("ingest beacon host (published bind interface)", () => {
  test("serialize then parse preserves an explicit host", () => {
    const state: IngestState = { pid: 1, port: 3132, host: "172.30.192.1" };
    expect(parseIngestState(serializeIngestState(state))).toEqual(state);
  });

  test("a host-less beacon is still valid (backward compatible)", () => {
    const parsed = parseIngestState(JSON.stringify({ pid: 1, port: 3132 }));
    expect(parsed).toEqual({ pid: 1, port: 3132 });
    expect(parsed?.host).toBeUndefined();
  });

  test("write then read from dir round-trips the host", async () => {
    const state: IngestState = { pid: 7, port: 3140, host: "127.0.0.1" };
    await writeIngestState(state, env);
    expect(await readIngestStateFromDir(home)).toEqual(state);
  });
});

describe("resolveIngestPort", () => {
  test("returns the bound port from a live ingest.json", async () => {
    await writeIngestState({ pid: process.pid, port: 3140 }, env);
    expect(await resolveIngestPort(env)).toBe(3140);
  });

  test("falls back to remote-host.json ingestPort when no ingest beacon exists", async () => {
    writeFileSync(join(home, "remote-host.json"), JSON.stringify({ tunnelId: "x", ingestPort: 3150 }));
    expect(await resolveIngestPort(env)).toBe(3150);
  });

  test("falls back to DEFAULT_INGEST_PORT when nothing is recorded", async () => {
    expect(await resolveIngestPort(env)).toBe(3132);
  });

  test("ignores a dead ingest beacon (pid not alive) and falls back", async () => {
    await writeIngestState({ pid: 999999, port: 3199 }, env);
    writeFileSync(join(home, "remote-host.json"), JSON.stringify({ tunnelId: "x", ingestPort: 3150 }));
    expect(await resolveIngestPort(env, { isAlive: () => false })).toBe(3150);
  });
});
