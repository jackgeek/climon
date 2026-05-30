import { afterEach, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeJsonFrame,
  FrameDecoder,
  FrameType,
  parseJsonPayload,
  type SpawnPayload,
  type SpawnedPayload
} from "../src/ipc/frame.js";

// Use a real Linux-filesystem temp dir for CLIMON_HOME: unix domain sockets do
// not work on DrvFs-mounted Windows drives (e.g. /mnt/c), which is where the
// repo lives in WSL.
const home = join(tmpdir(), `climon-spawn-routing-${process.pid}`);
const env = { ...process.env, CLIMON_HOME: home };

async function readMeta(id: string): Promise<{ socketPath: string; attached?: boolean }> {
  const raw = await readFile(join(home, "sessions", `${id}.json`), "utf8");
  return JSON.parse(raw) as { socketPath: string; attached?: boolean };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) {
      return v;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("daemon spawn routing", () => {
  test("relays a Spawn to a host client and routes the Spawned reply back", async () => {
    // Start a parent session daemon via the headless CLI path.
    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", "sleep", "30"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const parentId = (await new Response(proc.stdout).text()).trim();
    const parentSocket = (await waitFor(async () => (await readMeta(parentId)).socketPath)).toString();

    // Fake host client: connect, announce host via a host-sourced Resize, then
    // answer any Spawn frame with a canned Spawned reply.
    const host: Socket = connect(parentSocket);
    const hostDecoder = new FrameDecoder();
    await new Promise<void>((resolve) => host.once("connect", () => resolve()));
    host.write(encodeJsonFrame(FrameType.Resize, { cols: 80, rows: 24, source: "host" }));
    host.on("data", (chunk) => {
      for (const frame of hostDecoder.push(chunk)) {
        if (frame.type === FrameType.Spawn) {
          const req = parseJsonPayload<SpawnPayload>(frame.payload);
          host.write(encodeJsonFrame(FrameType.Spawned, { token: req.token, id: "child-1" }));
        }
      }
    });

    // Wait for the daemon to record attachment in metadata.
    await waitFor(async () => ((await readMeta(parentId)).attached ? true : undefined));

    // Fake server: a separate connection that sends a Spawn and reads the reply.
    const server: Socket = connect(parentSocket);
    const serverDecoder = new FrameDecoder();
    await new Promise<void>((resolve) => server.once("connect", () => resolve()));
    const reply = await new Promise<SpawnedPayload>((resolve) => {
      server.on("data", (chunk) => {
        for (const frame of serverDecoder.push(chunk)) {
          if (frame.type === FrameType.Spawned) {
            resolve(parseJsonPayload<SpawnedPayload>(frame.payload));
          }
        }
      });
      server.write(
        encodeJsonFrame(FrameType.Spawn, {
          token: "tok-9",
          command: ["sleep", "5"],
          cwd: "/tmp"
        })
      );
    });

    expect(reply).toEqual({ token: "tok-9", id: "child-1" });

    host.destroy();
    server.destroy();
    proc.kill();
    await proc.exited;
  }, 20000);

  test("replies with an error when no host client is attached", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", "sleep", "30"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const parentId = (await new Response(proc.stdout).text()).trim();
    const parentSocket = (await waitFor(async () => (await readMeta(parentId)).socketPath)).toString();

    const server: Socket = connect(parentSocket);
    const decoder = new FrameDecoder();
    await new Promise<void>((resolve) => server.once("connect", () => resolve()));
    const reply = await new Promise<SpawnedPayload>((resolve) => {
      server.on("data", (chunk) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.type === FrameType.Spawned) {
            resolve(parseJsonPayload<SpawnedPayload>(frame.payload));
          }
        }
      });
      server.write(
        encodeJsonFrame(FrameType.Spawn, { token: "tok-x", command: ["sleep", "5"], cwd: "/tmp" })
      );
    });

    expect(reply.token).toBe("tok-x");
    expect(reply.id).toBeUndefined();
    expect(reply.error).toContain("no attached client");

    server.destroy();
    proc.kill();
    await proc.exited;
  }, 20000);
});
