import { test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { IngestConnectionRegistry, runIngestConnection } from "../src/remote/ingest.js";
import { encodeControl } from "../src/remote/mux.js";
import { signControl } from "../src/remote/spawn-auth.js";
import type { Socket } from "node:net";

// A minimal duplex stand-in: writes go to `outbound`, the test feeds inbound.
// `socket` delegates event registration to `inbound` (its readable side) but
// routes `write` to `outbound`, so `inbound.write(...)` is NOT hijacked.
function pair(): { socket: Socket; inbound: PassThrough; outbound: PassThrough } {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const socket = {
    on: (ev: string, cb: (...args: unknown[]) => void) => inbound.on(ev, cb),
    once: (ev: string, cb: (...args: unknown[]) => void) => inbound.once(ev, cb),
    removeListener: (ev: string, cb: (...args: unknown[]) => void) => inbound.removeListener(ev, cb),
    write: (b: Buffer) => outbound.write(b),
    destroy: () => inbound.end(),
    destroyed: false,
    remoteAddress: "127.0.0.1",
    remotePort: 0
  } as unknown as Socket;
  return { socket, inbound, outbound };
}

test("verifies a signed SpawnResult and resolves the pending spawn", async () => {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  const registry = new IngestConnectionRegistry();
  const { socket, inbound } = pair();
  const pending = registry.registerPendingSpawn("req-1", 1000);
  const run = runIngestConnection(socket, {
    env,
    registry,
    spawnSecret: "sekret",
    keepAliveSeconds: 0
  });

  inbound.write(encodeControl({ kind: "hello", clientId: "dev" }));
  inbound.write(
    encodeControl(
      signControl("sekret", { kind: "spawn-result", requestId: "req-1", id: "abc" }, "n1", Date.now())
    )
  );

  await expect(pending).resolves.toEqual({ requestId: "req-1", id: "abc", warning: undefined, error: undefined });
  inbound.end();
  await run;
});
