import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIngestStateFromDir } from "../src/remote/ingest-state.js";
import { getShutdownRequestPathInDir, writeShutdownRequestToDir } from "../src/remote/shutdown-request.js";

let home: string;
const rustExe = process.platform === "win32" ? ".exe" : "";

function resolveRustIngestBinary(): string | undefined {
  for (const profile of ["debug", "release"]) {
    const candidate = join(process.cwd(), "rust", "target", profile, `climon${rustExe}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const rustIngestBinary = resolveRustIngestBinary();
const testWithRustIngest = rustIngestBinary ? test : test.skip;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 20000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Bound each attempt so a hung probe cannot block the loop past the deadline.
    const v = await Promise.race([
      Promise.resolve().then(fn).catch(() => undefined),
      new Promise<undefined>((r) => setTimeout(r, 1000, undefined))
    ]);
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

// Bind-based free check: true when host:port can be bound (i.e. nothing is
// listening). This is deterministic across platforms, unlike a connect-based
// probe — on Windows, connecting to a loopback port with no listener can hang
// (the SYN is dropped rather than refused) instead of failing fast.
function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, host, () => {
      s.close(() => resolve(true));
    });
  });
}

describe("ingest filesystem shutdown-request (integration)", () => {
  testWithRustIngest("a request demotes the ingest, frees the port, and consumes the beacons", async () => {
    if (!rustIngestBinary) {
      return;
    }
    home = mkdtempSync(join(tmpdir(), "climon-ingest-req-"));
    const env = { ...process.env, CLIMON_HOME: home };
    const ingest = Bun.spawn([rustIngestBinary, "__ingest"], {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe"
    });
    try {
      const state = await waitFor(async () => {
        const s = await readIngestStateFromDir(home);
        return s?.host ? s : undefined;
      }, 30000);
      // The ingest publishes its bound interface; on a non-Windows runner this is loopback.
      expect(state.host).toBeTruthy();
      expect(await tcpOpen(state.host!, state.port)).toBe(true);

      await writeShutdownRequestToDir(home, { requestedBy: "Windows", ts: Date.now() });

      await ingest.exited;
      expect(await readIngestStateFromDir(home)).toBeUndefined();
      expect(existsSync(getShutdownRequestPathInDir(home))).toBe(false);
      // Poll until the bound interface is bindable again, proving the ingest
      // released the port on demotion.
      const closed = await waitFor(async () => ((await portFree(state.host!, state.port)) ? true : undefined), 30000);
      expect(closed).toBe(true);
    } finally {
      ingest.kill();
      await ingest.exited;
    }
  }, 60000);
});
