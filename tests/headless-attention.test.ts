import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, NEST_LEVEL_ENV_VAR, SESSION_ENV_VAR } from "../src/config.js";
import { encodeFrame, encodeJsonFrame, FrameDecoder, FrameType, type AttentionPayload } from "../src/ipc/frame.js";
import { connectSessionSocket } from "../src/session-socket.js";
import { patchSessionMeta } from "../src/store.js";
import type { SessionMeta } from "../src/types.js";

// Use a real Linux-filesystem temp dir for CLIMON_HOME: unix domain sockets do
// not work on DrvFs-mounted Windows drives (e.g. /mnt/c), which is where the
// repo lives in WSL.
const home = join(tmpdir(), `climon-headless-attention-${process.pid}`);
const env: NodeJS.ProcessEnv = { ...process.env, CLIMON_HOME: home };
delete env[SESSION_ENV_VAR];
delete env[NEST_LEVEL_ENV_VAR];

async function readMeta(id: string): Promise<SessionMeta> {
  return JSON.parse(await readFile(join(home, "sessions", `${id}.json`), "utf8")) as SessionMeta;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 20000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Bound each attempt so a hung probe cannot block the loop past the deadline.
    const v = await Promise.race([
      Promise.resolve().then(fn).catch(() => undefined),
      new Promise<undefined>((r) => setTimeout(r, 1000, undefined))
    ]);
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

async function sendInput(id: string, data: string): Promise<void> {
  const meta = await readMeta(id);
  await new Promise<void>((resolve, reject) => {
    const socket = connectSessionSocket(meta.socketPath);
    socket.once("connect", () => {
      socket.write(encodeFrame(FrameType.Input, data), () => {
        // Give the daemon a moment to write the input to the PTY and absorb the
        // echo before disconnecting.
        setTimeout(() => {
          socket.end();
          resolve();
        }, 200);
      });
    });
    socket.once("error", reject);
  });
}

async function openViewerWithResize(id: string, cols: number, rows: number) {
  const meta = await readMeta(id);
  const socket = connectSessionSocket(meta.socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      socket.write(encodeJsonFrame(FrameType.Resize, { cols, rows, source: "viewer" }), () => resolve());
    });
    socket.once("error", reject);
  });
  // Drain incoming frames so the held-open viewer socket stays healthy. A real
  // browser viewer stays connected; disconnecting would revert the size and mask
  // the bug, so the caller is responsible for closing this socket.
  socket.on("data", () => {});
  return socket;
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
  }, 60000);

  test("acknowledging a static needs-attention session keeps it acknowledged until the screen changes", async () => {
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

      const acknowledged = await waitFor(async () => {
        const m = await readMeta(id);
        return m.status === "acknowledged" ? m : undefined;
      });
      expect(acknowledged.priorityReason).toBe("running");

      await new Promise((resolve) => setTimeout(resolve, 1500));
      const stillAcknowledged = await readMeta(id);
      expect(stillAcknowledged.status).toBe("acknowledged");
      expect(stillAcknowledged.priorityReason).toBe("running");
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
  }, 60000);

  test("a viewer resize does not clear attention on a still-idle session", async () => {
    await mkdir(home, { recursive: true });
    const config = defaultConfig();
    config.attention.idleSeconds = 1;
    await writeFile(join(home, "config.json"), JSON.stringify(config), "utf8");

    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "-e", "setTimeout(()=>{},30000)"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    let viewer: ReturnType<typeof connectSessionSocket> | undefined;
    try {
      const flagged = await waitFor(async () => {
        const m = await readMeta(id);
        return m.status === "needs-attention" ? m : undefined;
      });
      const token = flagged.attentionMatchedAt;

      // Viewing the session attaches a browser terminal that fits and resizes.
      // The viewer stays connected (closing it would revert the size and mask the
      // bug). The reflow must not be read as activity that clears attention.
      viewer = await openViewerWithResize(id, 40, 12);

      // Confirm the resize actually took effect (otherwise the test is vacuous).
      const resized = await waitFor(async () => {
        const m = await readMeta(id);
        return m.cols === 40 && m.rows === 12 ? m : undefined;
      });
      expect(resized.cols).toBe(40);

      // Span several idle sampling cycles to let any spurious transition surface.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const afterResize = await readMeta(id);
      expect(afterResize.status).toBe("needs-attention");
      expect(afterResize.priorityReason).toBe("attention");
      // Same outstanding attention event — never cleared and re-flagged.
      expect(afterResize.attentionMatchedAt).toBe(token);
    } finally {
      viewer?.destroy();
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
  }, 60000);

  test("viewing a needs-attention session (resize + ack) keeps it acknowledged", async () => {
    // Reproduces the two reported regressions: after the dashboard views a
    // needs-attention session — attaching a browser terminal that resizes and
    // then sends a user acknowledgement — the session must settle on
    // "acknowledged" and stay there. The viewer-resize reflow must not be read
    // as activity that (1) clears the ack to "running" or (2) re-flags
    // "needs-attention" once the reflowed screen goes idle again.
    await mkdir(home, { recursive: true });
    const config = defaultConfig();
    config.attention.idleSeconds = 1;
    await writeFile(join(home, "config.json"), JSON.stringify(config), "utf8");

    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "-e", "setTimeout(()=>{},30000)"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    let viewer: ReturnType<typeof connectSessionSocket> | undefined;
    try {
      const flagged = await waitFor(async () => {
        const m = await readMeta(id);
        return m.status === "needs-attention" ? m : undefined;
      });
      const token = flagged.attentionMatchedAt;

      // View the session: attach a browser viewer that resizes, then send the
      // user acknowledgement on the same held-open socket (as the dashboard does).
      viewer = await openViewerWithResize(id, 40, 12);
      await waitFor(async () => {
        const m = await readMeta(id);
        return m.cols === 40 && m.rows === 12 ? m : undefined;
      });
      viewer.write(
        encodeJsonFrame(FrameType.Attention, {
          needsAttention: false,
          reason: "viewed",
          attentionMatchedAt: token
        } satisfies AttentionPayload)
      );

      const acknowledged = await waitFor(async () => {
        const m = await readMeta(id);
        return m.status === "acknowledged" ? m : undefined;
      });
      expect(acknowledged.status).toBe("acknowledged");

      // Hold the viewer open and sample across several idle cycles. The status
      // must never leave "acknowledged" while the screen stays static.
      const seen = new Set<string>();
      for (let i = 0; i < 12; i++) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        seen.add((await readMeta(id)).status);
      }
      expect([...seen]).toEqual(["acknowledged"]);
    } finally {
      viewer?.destroy();
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
  }, 60000);

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
  }, 60000);

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
  }, 60000);

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
  }, 60000);

  test("output after the user's command settles into a fresh needs-attention", async () => {
    await mkdir(home, { recursive: true });
    const config = defaultConfig();
    config.attention.idleSeconds = 1;
    await writeFile(join(home, "config.json"), JSON.stringify(config), "utf8");

    // The program prints a line shortly after receiving input, then goes quiet.
    const script =
      "process.stdin.on('data',()=>{setTimeout(()=>process.stdout.write('done\\r\\n'),1500)});setTimeout(()=>{},30000)";
    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "-e", script],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    try {
      await waitFor(async () => {
        const m = await readMeta(id);
        return m.status === "needs-attention" ? m : undefined;
      });

      // Typing clears attention and suppresses the immediate echo screen.
      await sendInput(id, "go\n");
      await waitFor(async () => {
        const m = await readMeta(id);
        return m.status === "running" ? m : undefined;
      });

      // The later program output is genuinely new; once it settles the session
      // flags needs-attention again.
      const reflagged = await waitFor(async () => {
        const m = await readMeta(id);
        return m.status === "needs-attention" ? m : undefined;
      });
      expect(reflagged.status).toBe("needs-attention");
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
  }, 60000);
});
