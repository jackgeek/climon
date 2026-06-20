import { test, expect } from "bun:test";
import { IngestConnectionRegistry } from "../src/remote/ingest.js";
import type { Socket } from "node:net";

function fakeSocket(): Socket {
  return { destroy() {}, destroyed: false } as unknown as Socket;
}

test("getChannel returns the registered channel and undefined after teardown", async () => {
  const reg = new IngestConnectionRegistry();
  const ch = fakeSocket();
  await reg.evictAndRegister("dev", ch);
  expect(reg.getChannel("dev")).toBe(ch);
  expect(reg.getChannel("other")).toBeUndefined();
  reg.markTornDown("dev", ch);
  expect(reg.getChannel("dev")).toBeUndefined();
});

test("pending spawn resolves with the matching result", async () => {
  const reg = new IngestConnectionRegistry();
  const promise = reg.registerPendingSpawn("req-1", 1000);
  reg.resolvePendingSpawn("req-1", { requestId: "req-1", id: "abc" });
  await expect(promise).resolves.toEqual({ requestId: "req-1", id: "abc" });
});

test("pending spawn times out when no result arrives", async () => {
  const reg = new IngestConnectionRegistry();
  const result = await reg.registerPendingSpawn("req-2", 10);
  expect(result).toEqual({ requestId: "req-2", error: "timeout" });
});

test("resolving an unknown requestId is a no-op", () => {
  const reg = new IngestConnectionRegistry();
  expect(() => reg.resolvePendingSpawn("nope", { requestId: "nope" })).not.toThrow();
});
