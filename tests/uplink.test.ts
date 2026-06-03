import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSessionMeta } from "../src/store.js";
import { ensureClimonHome } from "../src/config.js";
import { MuxDecoder } from "../src/remote/mux.js";
import { ensureClientId, resolveUplinkConfig, runUplinkBridge } from "../src/remote/uplink.js";
import type { SessionMeta } from "../src/types.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "climon-uplink-"));
  env = { CLIMON_HOME: home };
  await ensureClimonHome(env);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("resolveUplinkConfig", () => {
  test("disabled unless tunnelId, token and port are all present", () => {
    // CLIMON_HOME has no config: nothing resolves.
    expect(resolveUplinkConfig(env, home).enabled).toBe(false);
  });
});

describe("ensureClientId", () => {
  test("generates once and persists a stable id", () => {
    const a = ensureClientId(env, home);
    const b = ensureClientId(env, home);
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  });
});

describe("runUplinkBridge", () => {
  test("sends hello then advertises existing local sessions", async () => {
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: "s1",
      command: ["bash"],
      displayCommand: "bash",
      cwd: "/x",
      status: "running",
      priorityReason: "running",
      socketPath: join(home, "nope.sock"),
      cols: 80,
      rows: 24,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now
    };
    await writeSessionMeta(meta, env);

    const received: string[] = [];
    const server: Server = createServer((socket: Socket) => {
      const decoder = new MuxDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const msg of decoder.push(chunk)) {
          if (msg.type === "control") received.push(msg.message.kind);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const client = connect(port, "127.0.0.1");
    await new Promise<void>((r) => client.once("connect", r));

    const done = runUplinkBridge(client, { env, clientId: "dev1" });
    await new Promise((r) => setTimeout(r, 200));
    client.destroy();
    await done;

    expect(received[0]).toBe("hello");
    expect(received).toContain("session-added");
    server.close();
  });
});
