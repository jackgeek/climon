import { test, expect } from "bun:test";
import { Buffer } from "node:buffer";
import { IngestConnectionRegistry, handleSpawnControlRequest } from "../src/remote/ingest.js";
import { MuxDecoder } from "../src/remote/mux.js";
import { verifySignedControl, ReplayGuard, DEFAULT_FRESHNESS_WINDOW_MS } from "../src/remote/spawn-auth.js";
import type { Socket } from "node:net";

function captureSocket(sink: Buffer[]): Socket {
  return {
    destroyed: false,
    write: (b: Buffer) => {
      sink.push(Buffer.from(b));
      return true;
    }
  } as unknown as Socket;
}

const baseReq = {
  type: "spawn" as const,
  requestId: "r1",
  clientId: "dev",
  command: ["bash"],
  cwd: "/w",
  cols: 80,
  rows: 24,
  headless: true
};

test("errors when the client is not connected", async () => {
  const reg = new IngestConnectionRegistry();
  const res = await handleSpawnControlRequest(baseReq, { registry: reg, spawnSecret: "sekret", timeoutMs: 50 });
  expect(res).toEqual({ type: "spawn-result", requestId: "r1", error: "client not connected" });
});

test("errors when no spawn secret is configured", async () => {
  const reg = new IngestConnectionRegistry();
  const sink: Buffer[] = [];
  await reg.evictAndRegister("dev", captureSocket(sink));
  const res = await handleSpawnControlRequest(baseReq, { registry: reg, spawnSecret: undefined, timeoutMs: 50 });
  expect(res).toEqual({ type: "spawn-result", requestId: "r1", error: "remote spawn not configured" });
});

test("signs and forwards a Spawn, then relays the resolved result", async () => {
  const reg = new IngestConnectionRegistry();
  const sink: Buffer[] = [];
  await reg.evictAndRegister("dev", captureSocket(sink));
  const pending = handleSpawnControlRequest(baseReq, { registry: reg, spawnSecret: "sekret", timeoutMs: 1000 });

  // The ingest should have written a signed Spawn to the channel.
  const out = new MuxDecoder().push(Buffer.concat(sink));
  expect(out).toHaveLength(1);
  const frame = out[0];
  expect(frame.type).toBe("control");
  const signed = (frame as { message: unknown }).message as { kind: string };
  expect(signed.kind).toBe("signed");
  const verified = verifySignedControl("sekret", signed as never, new ReplayGuard(DEFAULT_FRESHNESS_WINDOW_MS), Date.now());
  expect(verified.ok).toBe(true);
  if (verified.ok && verified.message.kind === "spawn") {
    expect(verified.message.command).toEqual(["bash"]);
    expect(verified.message.requestId).toBe("r1");
    // Simulate the devbox replying.
    reg.resolvePendingSpawn("r1", { requestId: "r1", id: "abc", warning: "no terminal" });
  }
  await expect(pending).resolves.toEqual({
    type: "spawn-result",
    requestId: "r1",
    id: "abc",
    warning: "no terminal",
    error: undefined
  });
});
