import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Server } from "node:net";
import { join } from "node:path";
import { listSessions, readSessionMeta } from "../src/store.js";
import { getRemoteHostPath } from "../src/config.js";
import { connectSessionSocket } from "../src/session-socket.js";
import { encodeControl, MuxDecoder } from "../src/remote/mux.js";
import { isValidRemoteId, runIngestConnection, TunnelHostSupervisor, toLocalMeta } from "../src/remote/ingest.js";
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

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Bound each attempt so a hung probe cannot block the loop past the deadline.
    const value = await Promise.race([
      Promise.resolve().then(fn).catch(() => undefined),
      new Promise<undefined>((r) => setTimeout(r, 1000, undefined))
    ]);
    if (value !== undefined) {
      return value;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
}

async function closeClientAndServer(
  client: ReturnType<typeof connect>,
  server: Server,
  sessionId?: string
): Promise<void> {
  client.destroy();
  if (sessionId) {
    await waitFor(async () => {
      const meta = await readSessionMeta(sessionId, env);
      return meta?.status === "disconnected" ? meta : undefined;
    }).catch(() => undefined);
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
  test("materializes a remote session as a local loopback TCP meta", async () => {
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
    for (let i = 0; i < 50 && (!meta || meta.socketPath.endsWith(":0")); i++) {
      await new Promise((r) => setTimeout(r, 20));
      meta = await readSessionMeta("dev1~s1", env);
    }
    expect(meta).toBeDefined();
    expect(meta?.origin).toBe("remote");
    expect(meta?.clientLabel).toBe("dev1");
    expect(meta?.socketPath).not.toBe("/should/be/ignored.sock");
    expect(meta?.socketPath).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/);

    client.destroy();
    const after = await waitFor(async () => {
      const meta = await readSessionMeta("dev1~s1", env);
      return meta?.status === "disconnected" ? meta : undefined;
    });
    expect(after.status).toBe("disconnected");
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
    for (let i = 0; i < 50 && (!meta || meta.socketPath === "tcp://127.0.0.1:0"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      meta = await readSessionMeta("dev1~s1", env);
    }
    expect(meta).toBeDefined();
    expect(meta?.socketPath).not.toBe("tcp://127.0.0.1:0");
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

    await closeClientAndServer(client, server, "dev1~s1");
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

    await closeClientAndServer(client, server, "dev1~s1");
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
    await closeClientAndServer(client, server);
  });

  test("requests remote attach for every local bridge connection", async () => {
    const server: Server = createServer((socket) => {
      void runIngestConnection(socket, { env, maxSessions: 10 });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const client = connect(port, "127.0.0.1");
    const decoder = new MuxDecoder();
    const attaches: string[] = [];
    const detaches: string[] = [];
    client.on("data", (chunk) => {
      for (const msg of decoder.push(chunk)) {
        if (msg.type === "control" && msg.message.kind === "attach") {
          attaches.push(msg.message.id);
        } else if (msg.type === "control" && msg.message.kind === "detach") {
          detaches.push(msg.message.id);
        }
      }
    });
    await new Promise<void>((r) => client.once("connect", r));
    client.write(encodeControl({ kind: "hello", clientId: "dev1" }));
    client.write(encodeControl({ kind: "session-added", meta: sampleMeta("s1") }));

    const meta = await waitFor(async () => {
      const value = await readSessionMeta("dev1~s1", env);
      return value?.origin === "remote" && !value.socketPath.endsWith(":0") ? value : undefined;
    });

    const first = connectSessionSocket(meta.socketPath);
    await new Promise<void>((r) => first.once("connect", r));
    await waitFor(async () => (attaches.length >= 1 ? true : undefined));

    const second = connectSessionSocket(meta.socketPath);
    await new Promise<void>((r) => second.once("connect", r));
    await waitFor(async () => (attaches.length >= 2 ? true : undefined));

    first.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(detaches).toEqual([]);

    second.destroy();
    await waitFor(async () => (detaches.length === 1 ? true : undefined));
    expect(attaches).toEqual(["s1", "s1"]);
    expect(detaches).toEqual(["s1"]);
    await closeClientAndServer(client, server, "dev1~s1");
  });

  test("tears down an idle mux channel whose keepalive is not answered", async () => {
    const server: Server = createServer((socket) => {
      void runIngestConnection(socket, { env, maxSessions: 10, keepAliveSeconds: 0.05 });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const client = connect(port, "127.0.0.1");
    await new Promise<void>((r) => client.once("connect", r));
    client.write(encodeControl({ kind: "hello", clientId: "dev1" }));
    client.write(encodeControl({ kind: "session-added", meta: sampleMeta("s1") }));

    await waitFor(async () => {
      const meta = await readSessionMeta("dev1~s1", env);
      return meta?.origin === "remote" ? meta : undefined;
    });

    const after = await waitFor(async () => {
      const meta = await readSessionMeta("dev1~s1", env);
      return meta?.status === "disconnected" ? meta : undefined;
    });

    expect(after.status).toBe("disconnected");
    await closeClientAndServer(client, server);
  });
});


describe("toLocalMeta", () => {
  test("carries a bounded attentionSnippet", () => {
    const remote = {
      id: "r1",
      command: ["bash"],
      displayCommand: "bash",
      cwd: "/tmp",
      status: "needs-attention",
      priorityReason: "attention",
      socketPath: "tcp://127.0.0.1:1",
      cols: 80,
      rows: 24,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      attentionSnippet: "Build finished. Deploy now?"
    } as unknown as SessionMeta;
    const local = toLocalMeta(remote, "peer", "local-r1", "tcp://127.0.0.1:2", {});
    expect(local.attentionSnippet).toBe("Build finished. Deploy now?");
  });

  test("truncates an over-long attentionSnippet", () => {
    const longSnippet = "x".repeat(5000);
    const remote = {
      id: "r2",
      command: ["bash"],
      displayCommand: "bash",
      cwd: "/tmp",
      status: "needs-attention",
      priorityReason: "attention",
      socketPath: "tcp://127.0.0.1:1",
      cols: 80,
      rows: 24,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      attentionSnippet: longSnippet
    } as unknown as SessionMeta;
    const local = toLocalMeta(remote, "peer", "local-r2", "tcp://127.0.0.1:2", {});
    expect(local.attentionSnippet).toBeDefined();
    expect(local.attentionSnippet!.length).toBe(4096); // MAX_STR
    expect(local.attentionSnippet).toBe("x".repeat(4096));
  });

  test("omits a non-string attentionSnippet", () => {
    const remote = {
      id: "r3",
      command: ["bash"],
      displayCommand: "bash",
      cwd: "/tmp",
      status: "running",
      priorityReason: "running",
      socketPath: "tcp://127.0.0.1:1",
      cols: 80,
      rows: 24,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      attentionSnippet: 42 as any
    } as unknown as SessionMeta;
    const local = toLocalMeta(remote, "peer", "local-r3", "tcp://127.0.0.1:2", {});
    expect(local.attentionSnippet).toBeUndefined();
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
