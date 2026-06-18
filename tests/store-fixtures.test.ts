import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseServerState } from "../src/server-state.js";
import type { SessionMeta, SessionMetaPatch } from "../src/types.js";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("store golden fixtures", () => {
  test("metadata merge matches the shared expected result", () => {
    const base = readJson<SessionMeta>("fixtures/store/merge/base.json");
    const patch = readJson<SessionMetaPatch>("fixtures/store/merge/patch.json");
    const expected = readJson<SessionMeta>("fixtures/store/merge/expected.json");

    // The store applies patches as a JS spread (later keys win); this mirrors
    // `merge_patch` in the Rust port exactly.
    const merged = { ...base, ...patch };
    expect(merged).toEqual(expected);

    // The explicit null color must override the base `cyan` (three-state).
    expect(merged.color).toBeNull();
    expect("color" in merged).toBe(true);
    expect(merged.status).toBe("completed");
    expect(merged.exitCode).toBe(0);
  });

  test("server-state fixtures parse identically to the Rust port", () => {
    const minimal = parseServerState(readFileSync("fixtures/store/server-state/minimal.json", "utf8"));
    expect(minimal).toEqual({ pid: 1234, port: 7421 });

    const full = parseServerState(readFileSync("fixtures/store/server-state/full.json", "utf8"));
    expect(full).toEqual({ pid: 9, port: 7421, ingest: 7500, startedAt: 1700000000000 });
  });
});
