import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.js";
import type { SessionMeta } from "../src/types.js";

// Use a real Linux-filesystem temp dir for CLIMON_HOME: unix domain sockets do
// not work on DrvFs-mounted Windows drives (e.g. /mnt/c), which is where the
// repo lives in WSL.
const home = join(tmpdir(), `climon-headless-attention-${process.pid}`);
const env = { ...process.env, CLIMON_HOME: home };

async function readMeta(id: string): Promise<SessionMeta> {
  return JSON.parse(await readFile(join(home, "sessions", `${id}.json`), "utf8")) as SessionMeta;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) {
      return v;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("headless session attention", () => {
  test("a headless session with no attached client flags needs-attention when idle", async () => {
    // Short idle window so the static screen flags quickly.
    await mkdir(home, { recursive: true });
    const config = defaultConfig();
    config.attention.idleSeconds = 1;
    await writeFile(join(home, "config.json"), JSON.stringify(config), "utf8");

    // `sleep` produces no output, so the rendered screen is static from launch.
    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", "sleep", "30"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    try {
      const meta = await waitFor(async () => {
        const m = await readMeta(id);
        return m.status === "needs-attention" ? m : undefined;
      });
      expect(meta.status).toBe("needs-attention");
      expect(meta.priorityReason).toBe("attention");
    } finally {
      const pid = await readMeta(id)
        .then((m) => m.daemonPid)
        .catch(() => undefined);
      if (pid) {
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
      }
      proc.kill();
      await proc.exited;
    }
  }, 20000);
});
