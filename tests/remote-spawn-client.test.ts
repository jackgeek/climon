import { test, expect } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestRemoteSpawn } from "../src/server/remote-spawn-client.js";
import { writeIngestState } from "../src/remote/ingest-state.js";
import { formatSessionSocketRef } from "../src/session-socket.js";
import type { SpawnControlRequest } from "../src/remote/ingest.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "climon-rsc-"));
}

const baseReq: SpawnControlRequest = {
  type: "spawn",
  requestId: "r1",
  clientId: "dev",
  command: ["bash"],
  cwd: "/home/dev",
  cols: 80,
  rows: 24,
  headless: false
};

/** Starts a loopback control server that captures the first request line. */
async function withControlServer(
  fn: (env: NodeJS.ProcessEnv, received: () => SpawnControlRequest | undefined) => Promise<void>,
  controlToken?: string
): Promise<void> {
  const home = tmpHome();
  const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
  let captured: SpawnControlRequest | undefined;
  const server = createServer((socket: Socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      captured = JSON.parse(buf.slice(0, nl)) as SpawnControlRequest;
      socket.write(
        JSON.stringify({ type: "spawn-result", requestId: captured.requestId, id: "child" }) + "\n"
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await writeIngestState(
    {
      pid: process.pid,
      port: 7000,
      host: "127.0.0.1",
      controlSocket: formatSessionSocketRef("127.0.0.1", port),
      controlToken
    },
    env
  );
  try {
    await fn(env, () => captured);
  } finally {
    server.close();
  }
}

test("forwards the ingest control token on the spawn request", async () => {
  await withControlServer(
    async (env, received) => {
      const res = await requestRemoteSpawn(baseReq, 5_000, env);
      expect(res.id).toBe("child");
      expect(received()?.controlToken).toBe("secret-token");
    },
    "secret-token"
  );
});

test("omits the control token when the beacon has none", async () => {
  await withControlServer(async (env, received) => {
    const res = await requestRemoteSpawn(baseReq, 5_000, env);
    expect(res.id).toBe("child");
    expect(received()?.controlToken).toBeUndefined();
  });
});
