import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server } from "node:net";
import { join } from "node:path";
import { listSessions, readSessionMeta } from "../src/store.js";
import { getRemoteHostPath } from "../src/config.js";
import { encodeControl } from "../src/remote/mux.js";
import { isValidRemoteId, runIngestConnection, TunnelHostSupervisor } from "../src/remote/ingest.js";
import type { SessionMeta } from "../src/types.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  const testTmp = join(process.cwd(), ".copilot-tmp");
  mkdirSync(testTmp, { recursive: true });
  home = mkdtempSync(join(testTmp, "climon-ingest-"));
  env = { CLIMON_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function sampleMeta(id: string): SessionMeta {
  const now = new Date().toISOString();
  return {
    id,
    command: ["bash"],
    displayCommand: "bash",
    cwd: "/home/dev",
    status: "running",
    priorityReason: "running",
    socketPath: "/should/be/ignored.sock",
    cols: 80,
    rows: 24,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now
  };
}

describe("isValidRemoteId", () => {
  test("accepts safe ids", () => {
    expect(isValidRemoteId("abc-123_x.y")).toBe(true);
  });
  test("rejects path traversal and overlong ids", () => {
    expect(isValidRemoteId("../etc")).toBe(false);
    expect(isValidRemoteId("a/b")).toBe(false);
    expect(isValidRemoteId("")).toBe(false);
    expect(isValidRemoteId("x".repeat(65))).toBe(false);
  });
});

describe("runIngestConnection", () => {
  test("materializes a remote session as a local unix-socket meta", async () => {
    // A loopback TCP server stands in for the ingest listener.
    const server: Server = createServer((socket) => {
      void runIngestConnection(socket, { env, maxSessions: 10 });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    const client = connect(port, "127.0.0.1");
    await new Promise<void>((r) => client.once("connect", r));
    client.write(encodeControl({ kind: "hello", clientId: "dev1" }));
    client.write(encodeControl({ kind: "session-added", meta: sampleMeta("s1") }));

    // Wait for the meta to land.
    let meta: SessionMeta | undefined;
    for (let i = 0; i < 50 && !meta; i++) {
      await new Promise((r) => setTimeout(r, 20));
      meta = await readSessionMeta("dev1~s1", env);
    }
    expect(meta).toBeDefined();
    expect(meta?.origin).toBe("remote");
    expect(meta?.clientLabel).toBe("dev1");
    expect(meta?.socketPath).not.toBe("/should/be/ignored.sock");

    client.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const after = await readSessionMeta("dev1~s1", env);
    expect(after?.status).toBe("disconnected");
    server.close();
  });

  test("rejects server-controlled fields in session updates", async () => {
    const server: Server = createServer((socket) => {
      void runIngestConnection(socket, { env, maxSessions: 10 });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const client = connect(port, "127.0.0.1");
    await new Promise<void>((r) => client.once("connect", r));
    client.write(encodeControl({ kind: "hello", clientId: "dev1" }));
    client.write(encodeControl({ kind: "session-added", meta: sampleMeta("s1") }));

    let meta: SessionMeta | undefined;
    for (let i = 0; i < 50 && !meta; i++) {
      await new Promise((r) => setTimeout(r, 20));
      meta = await readSessionMeta("dev1~s1", env);
    }
    expect(meta).toBeDefined();
    const socketPath = meta?.socketPath;

    client.write(
      encodeControl({
        kind: "session-updated",
        id: "s1",
        patch: { socketPath: "/evil.sock", origin: "local", clientLabel: "evil" } as never
      })
    );
    await new Promise((r) => setTimeout(r, 100));
    const after = await readSessionMeta("dev1~s1", env);
    expect(after?.socketPath).toBe(socketPath);
    expect(after?.origin).toBe("remote");
    expect(after?.clientLabel).toBe("dev1");

    client.destroy();
    server.close();
  });

  test("coerces invalid remote status reason and color on session add", async () => {
    const server: Server = createServer((socket) => {
      void runIngestConnection(socket, { env, maxSessions: 10 });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const client = connect(port, "127.0.0.1");
    await new Promise<void>((r) => client.once("connect", r));
    client.write(encodeControl({ kind: "hello", clientId: "dev1" }));

    const metaWithInvalidFields = sampleMeta("s1");
    metaWithInvalidFields.status = "totally-invalid" as any;
    metaWithInvalidFields.priorityReason = "because-i-said-so" as any;
    metaWithInvalidFields.color = "chartreuse" as any;
    client.write(encodeControl({ kind: "session-added", meta: metaWithInvalidFields }));

    let meta: SessionMeta | undefined;
    for (let i = 0; i < 50 && !meta; i++) {
      await new Promise((r) => setTimeout(r, 20));
      meta = await readSessionMeta("dev1~s1", env);
    }
    expect(meta).toBeDefined();
    expect(meta?.status).toBe("running");
    expect(meta?.priorityReason).toBe("running");
    expect(meta?.color).toBeUndefined();

    client.destroy();
    server.close();
  });

  test("rejects a malicious session id before any write", async () => {
    const server: Server = createServer((socket) => {
      void runIngestConnection(socket, { env, maxSessions: 10 });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const client = connect(port, "127.0.0.1");
    await new Promise<void>((r) => client.once("connect", r));
    client.write(encodeControl({ kind: "hello", clientId: "dev1" }));
    client.write(encodeControl({ kind: "session-added", meta: sampleMeta("../evil") }));
    await new Promise((r) => setTimeout(r, 100));
    expect(await listSessions(env)).toHaveLength(0);
    client.destroy();
    server.close();
  });
});


describe("TunnelHostSupervisor", () => {
  test("starts hosting when remote-host.json appears, stops when removed", async () => {
    const spawned: string[] = [];
    const killed: string[] = [];
    let activeId: string | undefined;
    const supervisor = new TunnelHostSupervisor({
      env,
      spawnHost: (tunnelId) => {
        spawned.push(tunnelId);
        activeId = tunnelId;
        return {
          stop: () => {
            killed.push(tunnelId);
            activeId = undefined;
          }
        };
      }
    });
    await supervisor.reconcile();
    expect(spawned).toHaveLength(0);

    writeFileSync(getRemoteHostPath(env), JSON.stringify({ tunnelId: "tunA", ingestPort: 3132 }));
    await supervisor.reconcile();
    expect(spawned).toEqual(["tunA"]);
    expect(activeId).toBe("tunA");

    await supervisor.reconcile();
    expect(spawned).toEqual(["tunA"]);

    writeFileSync(getRemoteHostPath(env), JSON.stringify({ tunnelId: "tunB", ingestPort: 3132 }));
    await supervisor.reconcile();
    expect(killed).toEqual(["tunA"]);
    expect(spawned).toEqual(["tunA", "tunB"]);

    rmSync(getRemoteHostPath(env), { force: true });
    await supervisor.reconcile();
    expect(killed).toEqual(["tunA", "tunB"]);
    supervisor.stop();
  });
});
