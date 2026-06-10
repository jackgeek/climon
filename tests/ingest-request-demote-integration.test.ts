import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIngestStateFromDir } from "../src/remote/ingest-state.js";
import { getShutdownRequestPathInDir, writeShutdownRequestToDir } from "../src/remote/shutdown-request.js";

let home: string;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

function tcpOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

describe("ingest filesystem shutdown-request (integration)", () => {
  test("a request demotes the ingest, frees the port, and consumes the beacons", async () => {
    home = mkdtempSync(join(tmpdir(), "climon-ingest-req-"));
    const env = { ...process.env, CLIMON_HOME: home };
    const ingest = Bun.spawn([process.execPath, "src/server.ts", "__ingest"], {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe"
    });
    try {
      const state = await waitFor(async () => {
        const s = await readIngestStateFromDir(home);
        return s?.host ? s : undefined;
      });
      // The ingest publishes its bound interface; on a non-Windows runner this is loopback.
      expect(state.host).toBeTruthy();
      expect(await tcpOpen(state.host!, state.port)).toBe(true);

      await writeShutdownRequestToDir(home, { requestedBy: "Windows", ts: Date.now() });

      await ingest.exited;
      expect(await readIngestStateFromDir(home)).toBeUndefined();
      expect(existsSync(getShutdownRequestPathInDir(home))).toBe(false);
      const closed = await waitFor(async () => ((await tcpOpen("127.0.0.1", state.port)) ? undefined : true));
      expect(closed).toBe(true);
    } finally {
      ingest.kill();
      await ingest.exited;
    }
  }, 30000);
});
