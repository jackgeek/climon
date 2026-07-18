import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, waitFor, waitForHealth } from "./support/server.js";

const home = join(tmpdir(), `climon-no-takeover-${process.pid}`);
const env = { ...process.env, CLIMON_HOME: home };

async function healthPort(base: string): Promise<number | undefined> {
  const res = await fetch(`${base}/health`).catch(() => undefined);
  if (!res?.ok) return undefined;
  const body = (await res.json()) as { ok?: boolean; ports?: { dashboard?: number } };
  return body.ok && body.ports?.dashboard ? body.ports.dashboard : undefined;
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("server --no-takeover", () => {
  test("starts a coexisting server on another port without killing the existing one", async () => {
    const port = await freePort();
    const first = Bun.spawn(
      [process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(port)],
      { cwd: process.cwd(), env, stdout: "ignore", stderr: "ignore" }
    );
    const firstBase = `http://127.0.0.1:${port}`;
    let second: Bun.Subprocess | undefined;
    try {
      // First server is up on the requested port.
      await waitForHealth(first, firstBase);
      const firstPort = await waitFor(() => healthPort(firstBase), 30000);
      expect(firstPort).toBe(port);

      // Second server requests the same (now occupied) port with --no-takeover.
      // It must not terminate the first; it must bind a different port instead.
      second = Bun.spawn(
        [process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(port)],
        { cwd: process.cwd(), env, stdout: "pipe", stderr: "ignore" }
      );

      // Parse the "port N is busy; using M instead" notice from stdout,
      // reading incrementally so we don't block waiting for the stream to close.
      const reader = (second.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let stdoutText = "";
      const secondPort = await waitFor(async () => {
        const { value, done } = await reader.read();
        if (value) stdoutText += decoder.decode(value, { stream: true });
        const match = stdoutText.match(/using (\d+) instead/);
        if (match) return Number(match[1]);
        return done ? -1 : undefined;
      }, 30000);
      reader.releaseLock();
      expect(secondPort).not.toBe(port);
      expect(secondPort).toBeGreaterThan(0);

      const secondBase = `http://127.0.0.1:${secondPort}`;
      const reported = await waitFor(() => healthPort(secondBase), 30000);
      expect(reported).toBe(secondPort);

      // Crucially, the first server is still alive and serving on its port.
      expect(await healthPort(firstBase)).toBe(port);
    } finally {
      second?.kill();
      if (second) await second.exited;
      first.kill();
      await first.exited;
    }
  }, 120000);
});
