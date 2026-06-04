import { afterEach, describe, expect, test } from "bun:test";
import { type Socket } from "node:net";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FrameDecoder,
  FrameType,
  encodeJsonFrame,
  parseJsonPayload,
  type PtySizePayload,
  type TerminalModePayload,
  type TerminalWarningPayload
} from "../src/ipc/frame.js";
import { connectSessionSocket, isResolvedSessionSocketRef } from "../src/session-socket.js";
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
  return connectSessionSocket(socketPath);
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("PTY reverts to host size when the last viewer leaves", () => {
  test("sends size and mode before replay when a viewer attaches", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "-e", "console.log('ready'); setTimeout(()=>{},30000)"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    const meta = await waitFor(async () => {
      const m = await readMeta(id).catch(() => undefined);
      return m?.socketPath && isResolvedSessionSocketRef(m.socketPath) ? m : undefined;
    });

    const viewer = open(meta.socketPath);
    const decoder = new FrameDecoder();
    const frameTypes: FrameType[] = [];
    viewer.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        frameTypes.push(frame.type);
      }
    });
    await new Promise((r) => viewer.once("connect", r));

    await waitFor(async () => (frameTypes.length >= 3 ? true : undefined));

    viewer.end();
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
    expect(frameTypes.slice(0, 3)).toEqual([FrameType.PtySize, FrameType.TerminalMode, FrameType.Replay]);
  }, 30000);

  test("a viewer shrinks the PTY, then disconnects and it restores", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "-e", "setTimeout(()=>{},30000)"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    const meta = await waitFor(async () => {
      const m = await readMeta(id).catch(() => undefined);
      return m?.socketPath && isResolvedSessionSocketRef(m.socketPath) ? m : undefined;
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

describe("fill window mode host warning and restore", () => {
  test("an overgrown fill-mode viewer warns only the host and host restore returns all clients to clamped mode", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "-e", "setTimeout(()=>{},30000)"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    const meta = await waitFor(async () => {
      const m = await readMeta(id).catch(() => undefined);
      return m?.socketPath && isResolvedSessionSocketRef(m.socketPath) ? m : undefined;
    });

    const host = open(meta.socketPath);
    const hostDecoder = new FrameDecoder();
    const hostWarnings: TerminalWarningPayload[] = [];
    host.on("data", (chunk) => {
      for (const frame of hostDecoder.push(chunk)) {
        if (frame.type === FrameType.TerminalWarning) {
          hostWarnings.push(parseJsonPayload<TerminalWarningPayload>(frame.payload));
        }
      }
    });
    await new Promise((r) => host.once("connect", r));
    host.write(encodeJsonFrame(FrameType.Resize, { cols: 80, rows: 24, source: "host" }));

    const viewer = open(meta.socketPath);
    const viewerDecoder = new FrameDecoder();
    const viewerSizes: PtySizePayload[] = [];
    const viewerModes: TerminalModePayload[] = [];
    const viewerWarnings: TerminalWarningPayload[] = [];
    viewer.on("data", (chunk) => {
      for (const frame of viewerDecoder.push(chunk)) {
        if (frame.type === FrameType.PtySize) {
          viewerSizes.push(parseJsonPayload<PtySizePayload>(frame.payload));
        } else if (frame.type === FrameType.TerminalMode) {
          viewerModes.push(parseJsonPayload<TerminalModePayload>(frame.payload));
        } else if (frame.type === FrameType.TerminalWarning) {
          viewerWarnings.push(parseJsonPayload<TerminalWarningPayload>(frame.payload));
        }
      }
    });
    await new Promise((r) => viewer.once("connect", r));

    viewer.write(encodeJsonFrame(FrameType.Resize, { cols: 140, rows: 40, source: "viewer", mode: "fill" }));

    await waitFor(async () =>
      viewerSizes.some((size) => size.cols === 140 && size.rows === 40) ? true : undefined
    );
    await waitFor(async () =>
      hostWarnings.some(
        (warning) =>
          warning.kind === "overgrown" &&
          warning.cols === 140 &&
          warning.rows === 40 &&
          warning.hostCols === 80 &&
          warning.hostRows === 24
      )
        ? true
        : undefined
    );
    expect(viewerWarnings).toEqual([]);

    host.write(encodeJsonFrame(FrameType.TerminalMode, { mode: "clamped" }));

    await waitFor(async () =>
      viewerModes.some((mode) => mode.mode === "clamped") &&
      viewerSizes.some((size) => size.cols === 80 && size.rows === 24)
        ? true
        : undefined
    );
    await waitFor(async () => (hostWarnings.some((warning) => warning.kind === "restored") ? true : undefined));

    host.end();
    viewer.end();
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
    expect(viewerModes.some((mode) => mode.mode === "clamped")).toBe(true);
    expect(viewerSizes.some((size) => size.cols === 80 && size.rows === 24)).toBe(true);
    expect(hostWarnings.some((warning) => warning.kind === "restored")).toBe(true);
  }, 30000);

  test("viewer disconnect clears the local host overgrown warning", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "-e", "setTimeout(()=>{},30000)"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    const meta = await waitFor(async () => {
      const m = await readMeta(id).catch(() => undefined);
      return m?.socketPath && isResolvedSessionSocketRef(m.socketPath) ? m : undefined;
    });

    const host = open(meta.socketPath);
    const hostDecoder = new FrameDecoder();
    const hostWarnings: TerminalWarningPayload[] = [];
    host.on("data", (chunk) => {
      for (const frame of hostDecoder.push(chunk)) {
        if (frame.type === FrameType.TerminalWarning) {
          hostWarnings.push(parseJsonPayload<TerminalWarningPayload>(frame.payload));
        }
      }
    });
    await new Promise((r) => host.once("connect", r));
    host.write(encodeJsonFrame(FrameType.Resize, { cols: 80, rows: 24, source: "host" }));

    const viewer = open(meta.socketPath);
    const viewerDecoder = new FrameDecoder();
    const viewerSizes: PtySizePayload[] = [];
    viewer.on("data", (chunk) => {
      for (const frame of viewerDecoder.push(chunk)) {
        if (frame.type === FrameType.PtySize) {
          viewerSizes.push(parseJsonPayload<PtySizePayload>(frame.payload));
        }
      }
    });
    await new Promise((r) => viewer.once("connect", r));

    viewer.write(encodeJsonFrame(FrameType.Resize, { cols: 140, rows: 40, source: "viewer", mode: "fill" }));

    await waitFor(async () =>
      viewerSizes.some((size) => size.cols === 140 && size.rows === 40) ? true : undefined
    );
    await waitFor(async () => (hostWarnings.some((warning) => warning.kind === "overgrown") ? true : undefined));

    viewer.end();

    await waitFor(async () => (hostWarnings.some((warning) => warning.kind === "restored") ? true : undefined));

    host.end();
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
    expect(hostWarnings.some((warning) => warning.kind === "overgrown")).toBe(true);
    expect(hostWarnings.some((warning) => warning.kind === "restored")).toBe(true);
  }, 30000);

  test("browser clamp mode request returns an overgrown fill session to the host size", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "-e", "setTimeout(()=>{},30000)"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    const meta = await waitFor(async () => {
      const m = await readMeta(id).catch(() => undefined);
      return m?.socketPath && isResolvedSessionSocketRef(m.socketPath) ? m : undefined;
    });

    const host = open(meta.socketPath);
    await new Promise((r) => host.once("connect", r));
    host.write(encodeJsonFrame(FrameType.Resize, { cols: 80, rows: 24, source: "host" }));

    const viewer = open(meta.socketPath);
    const viewerDecoder = new FrameDecoder();
    const viewerSizes: PtySizePayload[] = [];
    const viewerModes: TerminalModePayload[] = [];
    viewer.on("data", (chunk) => {
      for (const frame of viewerDecoder.push(chunk)) {
        if (frame.type === FrameType.PtySize) {
          viewerSizes.push(parseJsonPayload<PtySizePayload>(frame.payload));
        } else if (frame.type === FrameType.TerminalMode) {
          viewerModes.push(parseJsonPayload<TerminalModePayload>(frame.payload));
        }
      }
    });
    await new Promise((r) => viewer.once("connect", r));

    viewer.write(encodeJsonFrame(FrameType.Resize, { cols: 140, rows: 40, source: "viewer", mode: "fill" }));
    await waitFor(async () =>
      viewerSizes.some((size) => size.cols === 140 && size.rows === 40) ? true : undefined
    );

    viewer.write(encodeJsonFrame(FrameType.TerminalMode, { mode: "clamped" }));

    await waitFor(async () =>
      viewerModes.some((mode) => mode.mode === "clamped") &&
      viewerSizes.some((size) => size.cols === 80 && size.rows === 24)
        ? true
        : undefined
    );

    host.end();
    viewer.end();
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
    expect(viewerModes.some((mode) => mode.mode === "clamped")).toBe(true);
    expect(viewerSizes.some((size) => size.cols === 80 && size.rows === 24)).toBe(true);
  }, 30000);

  test("host resizes update the host cap without shrinking an active fill-mode viewer", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "-e", "setTimeout(()=>{},30000)"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    const meta = await waitFor(async () => {
      const m = await readMeta(id).catch(() => undefined);
      return m?.socketPath && isResolvedSessionSocketRef(m.socketPath) ? m : undefined;
    });

    const host = open(meta.socketPath);
    await new Promise((r) => host.once("connect", r));
    host.write(encodeJsonFrame(FrameType.Resize, { cols: 80, rows: 24, source: "host" }));

    const viewer = open(meta.socketPath);
    const viewerDecoder = new FrameDecoder();
    const viewerSizes: PtySizePayload[] = [];
    viewer.on("data", (chunk) => {
      for (const frame of viewerDecoder.push(chunk)) {
        if (frame.type === FrameType.PtySize) {
          viewerSizes.push(parseJsonPayload<PtySizePayload>(frame.payload));
        }
      }
    });
    await new Promise((r) => viewer.once("connect", r));

    viewer.write(encodeJsonFrame(FrameType.Resize, { cols: 140, rows: 40, source: "viewer", mode: "fill" }));
    await waitFor(async () =>
      viewerSizes.some((size) => size.cols === 140 && size.rows === 40) ? true : undefined
    );

    host.write(encodeJsonFrame(FrameType.Resize, { cols: 100, rows: 30, source: "host" }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    host.end();
    viewer.end();
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
    expect(viewerSizes.at(-1)).toEqual({ cols: 140, rows: 40 });
  }, 30000);

  test("clamped viewer resize receives the authoritative PTY size even when the PTY size is unchanged", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "-e", "setTimeout(()=>{},30000)"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    const meta = await waitFor(async () => {
      const m = await readMeta(id).catch(() => undefined);
      return m?.socketPath && isResolvedSessionSocketRef(m.socketPath) ? m : undefined;
    });

    const host = open(meta.socketPath);
    await new Promise((r) => host.once("connect", r));
    host.write(encodeJsonFrame(FrameType.Resize, { cols: 80, rows: 24, source: "host" }));

    const viewer = open(meta.socketPath);
    const viewerDecoder = new FrameDecoder();
    const viewerSizes: PtySizePayload[] = [];
    viewer.on("data", (chunk) => {
      for (const frame of viewerDecoder.push(chunk)) {
        if (frame.type === FrameType.PtySize) {
          viewerSizes.push(parseJsonPayload<PtySizePayload>(frame.payload));
        }
      }
    });
    await new Promise((r) => viewer.once("connect", r));
    await waitFor(async () =>
      viewerSizes.some((size) => size.cols === 80 && size.rows === 24) ? true : undefined
    );
    const before = viewerSizes.length;

    viewer.write(encodeJsonFrame(FrameType.Resize, { cols: 140, rows: 40, source: "viewer" }));

    await waitFor(async () =>
      viewerSizes.slice(before).some((size) => size.cols === 80 && size.rows === 24) ? true : undefined
    );

    host.end();
    viewer.end();
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
    expect(viewerSizes.slice(before).some((size) => size.cols === 80 && size.rows === 24)).toBe(true);
  }, 30000);

  test("a local client attaching after fill overgrowth receives the warning", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "-e", "setTimeout(()=>{},30000)"],
      { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
    );
    const id = (await new Response(proc.stdout).text()).trim();
    const meta = await waitFor(async () => {
      const m = await readMeta(id).catch(() => undefined);
      return m?.socketPath && isResolvedSessionSocketRef(m.socketPath) ? m : undefined;
    });

    const host1 = open(meta.socketPath);
    await new Promise((r) => host1.once("connect", r));
    host1.write(encodeJsonFrame(FrameType.Resize, { cols: 80, rows: 24, source: "host" }));

    const viewer = open(meta.socketPath);
    await new Promise((r) => viewer.once("connect", r));
    viewer.write(encodeJsonFrame(FrameType.Resize, { cols: 140, rows: 40, source: "viewer", mode: "fill" }));

    const host2 = open(meta.socketPath);
    const host2Decoder = new FrameDecoder();
    const host2Frames: FrameType[] = [];
    const host2Warnings: TerminalWarningPayload[] = [];
    host2.on("data", (chunk) => {
      for (const frame of host2Decoder.push(chunk)) {
        host2Frames.push(frame.type);
        if (frame.type === FrameType.TerminalWarning) {
          host2Warnings.push(parseJsonPayload<TerminalWarningPayload>(frame.payload));
        }
      }
    });
    await new Promise((r) => host2.once("connect", r));
    host2.write(encodeJsonFrame(FrameType.Resize, { cols: 80, rows: 24, source: "host" }));

    await waitFor(async () =>
      host2Warnings.some((warning) => warning.kind === "overgrown" && warning.cols === 140 && warning.rows === 40)
        ? true
        : undefined
    );

    host1.end();
    host2.end();
    viewer.end();
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
    expect(host2Warnings.some((warning) => warning.kind === "overgrown")).toBe(true);
    expect(host2Frames.indexOf(FrameType.TerminalWarning)).toBeLessThan(host2Frames.indexOf(FrameType.Replay));
  }, 30000);
});
