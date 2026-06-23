import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFileRequest } from "../src/server/file-endpoint.js";
import type { SessionMeta } from "../src/types.js";

let cwd = "";
const meta: Record<string, SessionMeta> = {};

function makeMeta(id: string, dir: string, origin: "local" | "remote"): SessionMeta {
  return {
    id,
    command: ["bash"],
    displayCommand: "bash",
    cwd: dir,
    status: "running",
    priorityReason: "running",
    cols: 80,
    rows: 24,
    socketPath: "tcp://127.0.0.1:1",
    origin,
    createdAt: "now",
    lastActivityAt: "now",
    updatedAt: "now"
  } as SessionMeta;
}

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "climon-fileapi-"));
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "a.txt"), "alpha\n");
  meta["local1"] = makeMeta("local1", cwd, "local");
  meta["rem~1"] = makeMeta("rem~1", cwd, "remote");
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const deps = {
  enabled: true,
  maxBytes: 1024,
  loadMeta: async (id: string) => meta[id] ?? null
};

describe("handleFileRequest", () => {
  test("returns 404 when the feature is disabled", async () => {
    const res = await handleFileRequest({ session: "local1", path: "a.txt" }, { ...deps, enabled: false });
    expect(res.status).toBe(404);
  });

  test("rejects an invalid session id with 400", async () => {
    const res = await handleFileRequest({ session: "../bad", path: "a.txt" }, deps);
    expect(res.status).toBe(400);
  });

  test("rejects an empty path with 400", async () => {
    const res = await handleFileRequest({ session: "local1", path: "" }, deps);
    expect(res.status).toBe(400);
  });

  test("returns 404 for an unknown session", async () => {
    const res = await handleFileRequest({ session: "missing", path: "a.txt" }, deps);
    expect(res.status).toBe(404);
  });

  test("reads a local file (status ok)", async () => {
    const res = await handleFileRequest({ session: "local1", path: "a.txt" }, deps);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    if (res.body.status === "ok") expect(res.body.content).toBe("alpha\n");
  });

  test("returns 501 for remote sessions (until Phase 2)", async () => {
    const res = await handleFileRequest({ session: "rem~1", path: "a.txt" }, deps);
    expect(res.status).toBe(501);
  });
});
