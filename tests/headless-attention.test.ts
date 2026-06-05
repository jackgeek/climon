import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.js";
import { encodeJsonFrame, FrameDecoder, FrameType, type AttentionPayload } from "../src/ipc/frame.js";
import { connectSessionSocket } from "../src/session-socket.js";
import { patchSessionMeta } from "../src/store.js";
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

async function acknowledgeAttention(id: string): Promise<void> {
  const meta = await readMeta(id);
  await new Promise<void>((resolve, reject) => {
    const socket = connectSessionSocket(meta.socketPath);
    const decoder = new FrameDecoder();
    socket.once("connect", () => {
      socket.write(encodeJsonFrame(FrameType.Attention, {
        needsAttention: false,
        reason: "viewed",
        attentionMatchedAt: meta.attentionMatchedAt
      } satisfies AttentionPayload));
    });
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.type === FrameType.Replay) {
          socket.end();
          resolve();
        }
      }
    });
    socket.once("error", reject);
  });
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

    // The long-lived Bun process produces no output, so the rendered screen is static from launch.
    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "-e", "setTimeout(()=>{},30000)"],
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

  test("acknowledging a static needs-attention session keeps it available until the screen changes", async () => {
    await mkdir(home, { recursive: true });
    const config = defaultConfig();
    config.attention.idleSeconds = 1;
    await writeFile(join(home, "config.json"), JSON.stringify(config), "utf8");

    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "-e", "setTimeout(()=>{},30000)"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    try {
      await waitFor(async () => {
        const m = await readMeta(id);
        return m.status === "needs-attention" ? m : undefined;
      });

      await acknowledgeAttention(id);

      const available = await waitFor(async () => {
        const m = await readMeta(id);
        return m.status === "available" ? m : undefined;
      });
      expect(available.priorityReason).toBe("running");

      await new Promise((resolve) => setTimeout(resolve, 1500));
      const stillAvailable = await readMeta(id);
      expect(stillAvailable.status).toBe("available");
      expect(stillAvailable.priorityReason).toBe("running");
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

  test("acknowledging a paused needs-attention session clears attention fields but preserves paused", async () => {
    await mkdir(home, { recursive: true });
    const config = defaultConfig();
    config.attention.idleSeconds = 1;
    await writeFile(join(home, "config.json"), JSON.stringify(config), "utf8");

    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "-e", "setTimeout(()=>{},30000)"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    try {
      const attentive = await waitFor(async () => {
        const m = await readMeta(id);
        return m.status === "needs-attention" ? m : undefined;
      });
      expect(attentive.attentionMatchedAt).toBeTruthy();

      await patchSessionMeta(id, { status: "paused" }, env);
      await acknowledgeAttention(id);

      const paused = await waitFor(async () => {
        const m = await readMeta(id);
        return m.attentionMatchedAt === undefined ? m : undefined;
      });
      expect(paused.status).toBe("paused");
      expect(paused.priorityReason).toBe("running");
      expect(paused.attentionReason).toBeUndefined();
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

  test("a paused idle session is not bumped to needs-attention by the daemon", async () => {
    await mkdir(home, { recursive: true });
    const config = defaultConfig();
    config.attention.idleSeconds = 1;
    await writeFile(join(home, "config.json"), JSON.stringify(config), "utf8");

    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "-e", "setTimeout(()=>{},30000)"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    try {
      await waitFor(async () => {
        const m = await readMeta(id);
        return m.daemonPid ? m : undefined;
      });

      await patchSessionMeta(id, { status: "paused", priorityReason: "running" }, env);
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const paused = await readMeta(id);
      expect(paused.status).toBe("paused");
      expect(paused.priorityReason).toBe("running");
      expect(paused.attentionMatchedAt).toBeUndefined();
      expect(paused.attentionReason).toBeUndefined();
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

  test("a paused session still records completed when the process exits", async () => {
    await mkdir(home, { recursive: true });
    const config = defaultConfig();
    config.attention.idleSeconds = 0;
    await writeFile(join(home, "config.json"), JSON.stringify(config), "utf8");

    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "-e", "setTimeout(()=>process.exit(0),1000)"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    try {
      await waitFor(async () => {
        const m = await readMeta(id);
        return m.daemonPid ? m : undefined;
      });
      await patchSessionMeta(id, { status: "paused" }, env);

      const completed = await waitFor(async () => {
        const m = await readMeta(id);
        return m.status === "completed" ? m : undefined;
      });
      expect(completed.exitCode).toBe(0);
      expect(completed.priorityReason).toBe("completed");
    } finally {
      proc.kill();
      await proc.exited.catch(() => undefined);
    }
  }, 20000);
});
