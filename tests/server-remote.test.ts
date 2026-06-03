import { describe, expect, test } from "bun:test";
import { shouldMarkDisconnected } from "../src/server/server.js";
import type { SessionMeta } from "../src/types.js";

function meta(over: Partial<SessionMeta>): SessionMeta {
  const now = new Date().toISOString();
  return {
    id: "x",
    command: ["bash"],
    displayCommand: "bash",
    cwd: "/x",
    status: "running",
    priorityReason: "running",
    socketPath: "/tmp/x.sock",
    cols: 80,
    rows: 24,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    ...over
  };
}

describe("shouldMarkDisconnected", () => {
  test("local session with dead daemon and no socket -> disconnected", async () => {
    const probe = async () => false;
    expect(await shouldMarkDisconnected(meta({ origin: "local", daemonPid: undefined }), probe)).toBe(true);
  });

  test("remote session probes the socket directly, ignoring missing daemonPid", async () => {
    const probeAlive = async () => true;
    expect(await shouldMarkDisconnected(meta({ origin: "remote", daemonPid: undefined }), probeAlive)).toBe(false);
  });

  test("remote session with dead socket -> disconnected", async () => {
    const probeDead = async () => false;
    expect(await shouldMarkDisconnected(meta({ origin: "remote" }), probeDead)).toBe(true);
  });

  test("terminated sessions are never touched", async () => {
    const probe = async () => false;
    expect(await shouldMarkDisconnected(meta({ status: "completed" }), probe)).toBe(false);
  });
});
