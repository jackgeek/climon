import { afterEach, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FrameDecoder,
  FrameType,
  encodeJsonFrame,
  parseJsonPayload,
  type PtySizePayload
} from "../src/ipc/frame.js";
import type { SessionMeta } from "../src/types.js";

// Real Linux tmp dir: unix sockets do not work on /mnt/c DrvFs under WSL.
const home = join(tmpdir(), `climon-revert-${process.pid}`);
const env = { ...process.env, CLIMON_HOME: home, CLIMON_COLS: "80", CLIMON_ROWS: "24" };

async function readMeta(id: string): Promise<SessionMeta> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(join(home, "sessions", `${id}.json`), "utf8")) as SessionMeta;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
}

function open(socketPath: string): Socket {
  return connect(socketPath);
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("PTY reverts to host size when the last viewer leaves", () => {
  test("a viewer shrinks the PTY, then disconnects and it restores", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", "sleep", "30"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    const meta = await waitFor(async () => {
      const m = await readMeta(id).catch(() => undefined);
      return m?.socketPath ? m : undefined;
    });

    // Observer stays connected and records every PtySize broadcast.
    const observer = open(meta.socketPath);
    const sizes: PtySizePayload[] = [];
    const decoder = new FrameDecoder();
    observer.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.type === FrameType.PtySize) {
          sizes.push(parseJsonPayload<PtySizePayload>(frame.payload));
        }
      }
    });
    await new Promise((r) => observer.once("connect", r));

    // Viewer connects and shrinks the PTY below the host size.
    const viewer = open(meta.socketPath);
    await new Promise((r) => viewer.once("connect", r));
    viewer.write(encodeJsonFrame(FrameType.Resize, { cols: 40, rows: 12, source: "viewer" }));

    const shrinkIndex = await waitFor(async () => {
      const index = sizes.findIndex((s) => s.cols === 40 && s.rows === 12);
      return index >= 0 ? index : undefined;
    });

    // Viewer leaves: the daemon restores the host dimensions (80x24).
    viewer.end();
    await waitFor(async () =>
      sizes.slice(shrinkIndex + 1).some((s) => s.cols === 80 && s.rows === 24) ? true : undefined
    );

    observer.end();
    const pid = (await readMeta(id)).daemonPid;
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    proc.kill();
    await proc.exited;
    expect(sizes.slice(shrinkIndex + 1).some((s) => s.cols === 80 && s.rows === 24)).toBe(true);
  }, 30000);
});
