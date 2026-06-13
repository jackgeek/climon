import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { type Socket } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, NEST_LEVEL_ENV_VAR, SESSION_ENV_VAR } from "../src/config.js";
import { patchSessionMeta } from "../src/store.js";
import { FrameDecoder, FrameType, parseJsonPayload, type TitlePayload } from "../src/ipc/frame.js";
import { connectSessionSocket, isResolvedSessionSocketRef } from "../src/session-socket.js";
import type { SessionMeta } from "../src/types.js";

// Real Linux-filesystem temp dir: unix sockets do not work on DrvFs mounts.
const home = join(tmpdir(), `climon-title-broadcast-${process.pid}`);
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

/**
 * Connects to a daemon socket and resolves the name of the first Title frame
 * received that satisfies `predicate`. Keeps the socket open for the duration.
 */
function awaitTitle(socket: Socket, predicate: (name: string) => boolean, ms = 5000): Promise<string> {
  const decoder = new FrameDecoder();
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for Title frame")), ms);
    socket.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.type === FrameType.Title) {
          const { name } = parseJsonPayload<TitlePayload>(frame.payload);
          if (predicate(name)) {
            clearTimeout(timer);
            resolve(name);
          }
        }
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("daemon Title broadcast", () => {
  test("sends the name on connect and rebroadcasts on rename", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify(defaultConfig()), "utf8");

    const proc = Bun.spawn(
      [
        process.execPath,
        "src/index.ts",
        "run",
        "--headless",
        "--name",
        "first name",
        process.execPath,
        "-e",
        "setTimeout(()=>{},30000)"
      ],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();

    let socket: Socket | undefined;
    try {
      const meta = await waitFor(async () => {
        const m = await readMeta(id);
        return isResolvedSessionSocketRef(m.socketPath) ? m : undefined;
      });

      socket = connectSessionSocket(meta.socketPath);
      await new Promise<void>((resolve, reject) => {
        socket!.once("connect", () => resolve());
        socket!.once("error", reject);
      });

      // Initial title from the launch name.
      const initial = await awaitTitle(socket, (name) => name === "first name");
      expect(initial).toBe("first name");

      // Simulate a dashboard rename; the file watcher should rebroadcast.
      const rename = awaitTitle(socket, (name) => name === "second name", 6000);
      await patchSessionMeta(id, { name: "second name" }, env);
      expect(await rename).toBe("second name");
    } finally {
      socket?.destroy();
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
