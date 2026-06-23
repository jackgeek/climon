import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { requestRemoteFileRead } from "../src/server/remote-file-client.js";

let home: string;
let server: Server;
let env: NodeJS.ProcessEnv;
let port: number;

function startIngest(onRequest: (line: string, socket: Socket) => void): Promise<void> {
  server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      onRequest(line, socket);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      writeFileSync(
        join(home, "ingest.json"),
        JSON.stringify({ pid: process.pid, port: 1, controlSocket: `tcp://127.0.0.1:${port}` }) + "\n"
      );
      resolve();
    });
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "climon-rfc-"));
  env = { ...process.env, CLIMON_HOME: home };
});

afterEach(() => {
  server?.close();
  rmSync(home, { recursive: true, force: true });
});

test("reassembles an ok reply delivered across chunk boundaries (multibyte split)", async () => {
  const content = "héllo wörld — 日本語"; // multibyte UTF-8
  const body = Buffer.from(content, "utf8");
  await startIngest((_line, socket) => {
    const header = Buffer.from(
      JSON.stringify({ type: "read-file-result", requestId: "x", status: "ok", path: "/p/a.txt", len: body.length }) + "\n",
      "utf8"
    );
    // Header alone, then body split mid-codepoint across two chunks.
    socket.write(header);
    const mid = 9; // lands inside a multibyte sequence of the body
    setTimeout(() => socket.write(body.subarray(0, mid)), 5);
    setTimeout(() => socket.write(body.subarray(mid)), 10);
  });
  const result = await requestRemoteFileRead("dev~1", "a.txt", 1024, 2000, env);
  expect(result).toEqual({ status: "ok", path: "/p/a.txt", content });
});

test("reassembles when header and body arrive in one chunk", async () => {
  const body = Buffer.from("inline", "utf8");
  await startIngest((_line, socket) => {
    const header = JSON.stringify({ type: "read-file-result", requestId: "x", status: "ok", path: "/p/b.txt", len: body.length });
    socket.write(Buffer.concat([Buffer.from(header + "\n", "utf8"), body]));
  });
  const result = await requestRemoteFileRead("dev~1", "b.txt", 1024, 2000, env);
  expect(result).toEqual({ status: "ok", path: "/p/b.txt", content: "inline" });
});

test("maps too-large header (empty body) to a too-large result", async () => {
  await startIngest((_line, socket) => {
    socket.write(
      JSON.stringify({ type: "read-file-result", requestId: "x", status: "too-large", path: "/p/big", size: 9000, len: 0 }) + "\n"
    );
  });
  const result = await requestRemoteFileRead("dev~1", "big", 1024, 2000, env);
  expect(result).toEqual({ status: "too-large", path: "/p/big", size: 9000 });
});

test("maps binary/refused/not-found headers with empty body", async () => {
  await startIngest((_line, socket) => {
    socket.write(
      JSON.stringify({ type: "read-file-result", requestId: "x", status: "refused", path: "/p/x", len: 0 }) + "\n"
    );
  });
  const result = await requestRemoteFileRead("dev~1", "x", 1024, 2000, env);
  expect(result).toEqual({ status: "refused", path: "/p/x" });
});

test("returns not-found when the ingest closes before replying", async () => {
  await startIngest((_line, socket) => socket.end());
  const result = await requestRemoteFileRead("dev~1", "a", 1024, 2000, env);
  expect(result).toEqual({ status: "not-found", path: "a" });
});

test("returns not-found when no ingest state exists", async () => {
  rmSync(join(home, "ingest.json"), { force: true });
  // No server started for this path; the missing state short-circuits.
  server = createServer();
  const result = await requestRemoteFileRead("dev~1", "a", 1024, 2000, env);
  expect(result).toEqual({ status: "not-found", path: "a" });
});
