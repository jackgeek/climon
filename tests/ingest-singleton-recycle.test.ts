import { describe, expect, test } from "bun:test";
import { ingestNeedsRecycle } from "../src/remote/ingest.js";
import type { IngestState } from "../src/remote/ingest-state.js";

const beacon = (host?: string): IngestState =>
  host === undefined
    ? { pid: 1, port: 3132 }
    : { pid: 1, port: 3132, host };

describe("ingestNeedsRecycle", () => {
  test("recycles when there is no beacon (pre-feature singleton / migration bug)", () => {
    expect(ingestNeedsRecycle(undefined, "127.0.0.1")).toBe(true);
  });
  test("recycles a host-less beacon (PR #65 era)", () => {
    expect(ingestNeedsRecycle(beacon(undefined), "127.0.0.1")).toBe(true);
  });
  test("recycles a beacon bound to the wrong interface", () => {
    expect(ingestNeedsRecycle(beacon("127.0.0.1"), "172.30.192.1")).toBe(true);
  });
  test("keeps a beacon bound to the expected interface", () => {
    expect(ingestNeedsRecycle(beacon("172.30.192.1"), "172.30.192.1")).toBe(false);
  });
});
