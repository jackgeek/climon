import { expect, test } from "bun:test";
import { handleFileRequest } from "../src/server/file-endpoint.js";
import type { SessionMeta } from "../src/types.js";

const remoteMeta = {
  id: "dev~1",
  command: ["bash"],
  displayCommand: "bash",
  cwd: "/remote/project",
  status: "running",
  priorityReason: "none",
  cols: 80,
  rows: 24,
  socketPath: "tcp://127.0.0.1:1",
  origin: "remote",
  createdAt: "now",
  updatedAt: "now",
  lastActivityAt: "now"
} as unknown as SessionMeta;

test("routes remote sessions through readRemoteFile", async () => {
  const calls: Array<{ id: string; path: string }> = [];
  const res = await handleFileRequest(
    { session: "dev~1", path: "src/a.ts" },
    {
      enabled: true,
      maxBytes: 1024,
      loadMeta: async () => remoteMeta,
      readRemoteFile: async (id, path) => {
        calls.push({ id, path });
        return { status: "ok", path: "/remote/project/src/a.ts", content: "remote" };
      }
    }
  );
  expect(res.status).toBe(200);
  expect(calls).toEqual([{ id: "dev~1", path: "src/a.ts" }]);
});

test("returns 501 for remote sessions when readRemoteFile is not provided", async () => {
  const res = await handleFileRequest(
    { session: "dev~1", path: "src/a.ts" },
    {
      enabled: true,
      maxBytes: 1024,
      loadMeta: async () => remoteMeta
    }
  );
  expect(res.status).toBe(501);
});
