import { expect, test } from "@playwright/test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { platformFromNode } from "../src/platform.js";
import type { BuildArtifacts } from "../src/build.js";
import type { CommandSpec, CommandResult, CommandRunner } from "../src/command.js";
import {
  HarnessEnvironment,
  parseServerState,
  pollServerReady,
  type FetchFn,
  type HarnessEnvironmentInit,
  type OwnedProcess,
} from "../src/environment.js";
import { HarnessError } from "../src/types.js";

const platform = platformFromNode(process.platform);
const root = resolve(import.meta.dirname, "../..");

// ── Test helpers ─────────────────────────────────────────────────────────────

let idCounter = 0;
async function makeTempDirs() {
  const n = ++idCounter;
  const home = join(tmpdir(), `climon-env-home-${n}-${Date.now()}`);
  const artifactRoot = join(tmpdir(), `climon-env-art-${n}-${Date.now()}`);
  await mkdir(home, { recursive: true });
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  return { home, artifactRoot };
}

class RecordingRunner implements CommandRunner {
  readonly calls: CommandSpec[] = [];
  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec);
    return { code: 0, signal: null, durationMs: 0, stdout: "", stderr: "" };
  }
}

function makeOwnedProcess(pid = 9999): OwnedProcess & { killCount: number } {
  let killCount = 0;
  return {
    pid,
    kill() { killCount++; },
    async wait() { return 0; },
    get killCount() { return killCount; },
  };
}

function makeInit(
  home: string,
  artifactRoot: string,
  overrides: Partial<HarnessEnvironmentInit> = {}
): HarnessEnvironmentInit {
  const artifacts: BuildArtifacts = {
    clientPath: join(root, "fake-climon"),
    serverPath: join(root, "fake-climon-server"),
    fixturePath: join(root, "harness", "fixtures", "echo-session.mjs"),
  };
  return {
    root,
    platform,
    home,
    artifactRoot,
    artifacts,
    baseUrl: "http://127.0.0.1:9999",
    runner: new RecordingRunner(),
    runtimeEnv: { CLIMON_HOME: home, PATH: process.env.PATH ?? "/usr/bin" },
    serverProcess: makeOwnedProcess(),
    sessionPollIntervalMs: 10,
    sessionWaitTimeoutMs: 200,
    ...overrides,
  };
}

// ── parseServerState ─────────────────────────────────────────────────────────

test("parseServerState: returns {pid, port} for valid positive integers", () => {
  const result = parseServerState('{"pid":1234,"port":8080}');
  expect(result).toEqual({ pid: 1234, port: 8080 });
});

test("parseServerState: returns undefined when pid is 0", () => {
  expect(parseServerState('{"pid":0,"port":8080}')).toBeUndefined();
});

test("parseServerState: returns undefined when pid is negative", () => {
  expect(parseServerState('{"pid":-1,"port":8080}')).toBeUndefined();
});

test("parseServerState: returns undefined when port is 0", () => {
  expect(parseServerState('{"pid":1234,"port":0}')).toBeUndefined();
});

test("parseServerState: returns undefined when port is negative", () => {
  expect(parseServerState('{"pid":1234,"port":-1}')).toBeUndefined();
});

test("parseServerState: returns undefined when pid is a float", () => {
  expect(parseServerState('{"pid":1234.5,"port":8080}')).toBeUndefined();
});

test("parseServerState: returns undefined when port is a float", () => {
  expect(parseServerState('{"pid":1234,"port":8080.5}')).toBeUndefined();
});

test("parseServerState: returns undefined when pid field is missing", () => {
  expect(parseServerState('{"port":8080}')).toBeUndefined();
});

test("parseServerState: returns undefined when port field is missing", () => {
  expect(parseServerState('{"pid":1234}')).toBeUndefined();
});

test("parseServerState: returns undefined for malformed JSON", () => {
  expect(parseServerState("not-json")).toBeUndefined();
});

test("parseServerState: returns undefined for empty string", () => {
  expect(parseServerState("")).toBeUndefined();
});

// ── readSessionMeta ──────────────────────────────────────────────────────────

test("readSessionMeta: reads and validates session with id and status", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  await writeFile(
    join(home, "sessions", "abc.json"),
    JSON.stringify({ id: "abc", status: "active" })
  );
  const env = new HarnessEnvironment(makeInit(home, artifactRoot));
  const meta = await env.readSessionMeta("abc");
  expect(meta.id).toBe("abc");
  expect(meta.status).toBe("active");
});

test("readSessionMeta: includes optional exitCode when present", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  await writeFile(
    join(home, "sessions", "def.json"),
    JSON.stringify({ id: "def", status: "completed", exitCode: 0 })
  );
  const env = new HarnessEnvironment(makeInit(home, artifactRoot));
  const meta = await env.readSessionMeta("def");
  expect(meta.exitCode).toBe(0);
});

test("readSessionMeta: includes optional name when present", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  await writeFile(
    join(home, "sessions", "ghi.json"),
    JSON.stringify({ id: "ghi", status: "active", name: "my-session" })
  );
  const env = new HarnessEnvironment(makeInit(home, artifactRoot));
  const meta = await env.readSessionMeta("ghi");
  expect(meta.name).toBe("my-session");
});

test("readSessionMeta: throws HarnessError assertion when id in file does not match requested id", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  await writeFile(
    join(home, "sessions", "xyz.json"),
    JSON.stringify({ id: "other-id", status: "active" })
  );
  const env = new HarnessEnvironment(makeInit(home, artifactRoot));
  const err = await env.readSessionMeta("xyz").catch((e) => e);
  expect(err).toBeInstanceOf(HarnessError);
  expect((err as HarnessError).kind).toBe("assertion");
});

test("readSessionMeta: throws HarnessError assertion when status field is missing", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  await writeFile(
    join(home, "sessions", "bad.json"),
    JSON.stringify({ id: "bad" })
  );
  const env = new HarnessEnvironment(makeInit(home, artifactRoot));
  const err = await env.readSessionMeta("bad").catch((e) => e);
  expect(err).toBeInstanceOf(HarnessError);
  expect((err as HarnessError).kind).toBe("assertion");
});

test("readSessionMeta: throws HarnessError assertion when file contains malformed JSON", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  await writeFile(join(home, "sessions", "mal.json"), "not json");
  const env = new HarnessEnvironment(makeInit(home, artifactRoot));
  const err = await env.readSessionMeta("mal").catch((e) => e);
  expect(err).toBeInstanceOf(HarnessError);
  expect((err as HarnessError).kind).toBe("assertion");
});

// ── waitForSessionStatus ─────────────────────────────────────────────────────

test("waitForSessionStatus: resolves when status already matches at first poll", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  await writeFile(
    join(home, "sessions", "s1.json"),
    JSON.stringify({ id: "s1", status: "completed" })
  );
  const env = new HarnessEnvironment(makeInit(home, artifactRoot));
  await expect(env.waitForSessionStatus("s1", "completed")).resolves.toBeUndefined();
});

test("waitForSessionStatus: resolves when status changes before timeout", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  const sessionFile = join(home, "sessions", "s2.json");
  await writeFile(sessionFile, JSON.stringify({ id: "s2", status: "active" }));

  const env = new HarnessEnvironment(makeInit(home, artifactRoot));

  // Update file to completed after 50ms
  setTimeout(() => {
    void writeFile(sessionFile, JSON.stringify({ id: "s2", status: "completed" }));
  }, 50);

  await expect(
    env.waitForSessionStatus("s2", "completed", 2_000)
  ).resolves.toBeUndefined();
});

test("waitForSessionStatus: throws HarnessError timeout when status not reached within timeout", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  await writeFile(
    join(home, "sessions", "s3.json"),
    JSON.stringify({ id: "s3", status: "active" })
  );
  const env = new HarnessEnvironment(makeInit(home, artifactRoot));
  const err = await env.waitForSessionStatus("s3", "completed", 150).catch((e) => e);
  expect(err).toBeInstanceOf(HarnessError);
  expect((err as HarnessError).kind).toBe("timeout");
});

// ── findSessionIdByName ──────────────────────────────────────────────────────

test("findSessionIdByName: returns session id when exactly one session matches name", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  await writeFile(
    join(home, "sessions", "n1.json"),
    JSON.stringify({ id: "n1", status: "active", name: "my-test" })
  );
  const env = new HarnessEnvironment(makeInit(home, artifactRoot));
  const id = await env.findSessionIdByName("my-test", 2_000);
  expect(id).toBe("n1");
});

test("findSessionIdByName: throws HarnessError assertion when multiple sessions match name", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  await writeFile(
    join(home, "sessions", "n2a.json"),
    JSON.stringify({ id: "n2a", status: "active", name: "dup-name" })
  );
  await writeFile(
    join(home, "sessions", "n2b.json"),
    JSON.stringify({ id: "n2b", status: "active", name: "dup-name" })
  );
  const env = new HarnessEnvironment(makeInit(home, artifactRoot));
  const err = await env.findSessionIdByName("dup-name", 2_000).catch((e) => e);
  expect(err).toBeInstanceOf(HarnessError);
  expect((err as HarnessError).kind).toBe("assertion");
});

test("findSessionIdByName: throws HarnessError timeout when no session matches within timeout", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  const env = new HarnessEnvironment(makeInit(home, artifactRoot));
  const err = await env.findSessionIdByName("nonexistent", 150).catch((e) => e);
  expect(err).toBeInstanceOf(HarnessError);
  expect((err as HarnessError).kind).toBe("timeout");
});

test("findSessionIdByName: ignores malformed JSON session files", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  await writeFile(join(home, "sessions", "bad.json"), "not json");
  await writeFile(
    join(home, "sessions", "good.json"),
    JSON.stringify({ id: "good", status: "active", name: "target" })
  );
  const env = new HarnessEnvironment(makeInit(home, artifactRoot));
  const id = await env.findSessionIdByName("target", 2_000);
  expect(id).toBe("good");
});

// ── snapshotState ────────────────────────────────────────────────────────────

test("snapshotState: copies regular files from home to destination", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  await writeFile(join(home, "canary.txt"), "snapshot-content");

  const dest = join(artifactRoot, "snapshot-out");
  await mkdir(dest, { recursive: true });

  const env = new HarnessEnvironment(makeInit(home, artifactRoot));
  await env.snapshotState(dest);

  const content = await readFile(join(dest, "canary.txt"), "utf8");
  expect(content).toBe("snapshot-content");
});

test("snapshotState: copies nested session files into snapshot", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  await writeFile(
    join(home, "sessions", "s.json"),
    JSON.stringify({ id: "s", status: "active" })
  );

  const dest = join(artifactRoot, "snapshot-out-2");
  await mkdir(dest, { recursive: true });

  const env = new HarnessEnvironment(makeInit(home, artifactRoot));
  await env.snapshotState(dest);

  const names = await readdir(join(dest, "sessions"));
  expect(names).toContain("s.json");
});

// ── dispose ──────────────────────────────────────────────────────────────────

test("dispose: invokes clientPath ['kill', id] with runtime env for non-terminal tracked session", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  await writeFile(
    join(home, "sessions", "live.json"),
    JSON.stringify({ id: "live", status: "active" })
  );

  const runner = new RecordingRunner();
  const clientPath = join(root, "fake-climon");
  const runtimeEnv = { CLIMON_HOME: home, PATH: "/usr/bin" };

  const env = new HarnessEnvironment(
    makeInit(home, artifactRoot, {
      runner,
      artifacts: {
        clientPath,
        serverPath: join(root, "fake-server"),
        fixturePath: join(root, "harness", "fixtures", "echo-session.mjs"),
      },
      runtimeEnv,
      sessionPollIntervalMs: 10,
      sessionWaitTimeoutMs: 100,
    })
  );

  env.trackSession("live");

  // dispose attempts kill then waits; session never becomes terminal → cleanup error
  await env.dispose().catch(() => {/* expected */});

  // Kill must have been invoked with the specific client binary, not a broad kill
  const killCall = runner.calls.find(
    (c) => c.file === clientPath && c.args[0] === "kill"
  );
  expect(killCall).toBeDefined();
  expect(killCall!.args).toEqual(["kill", "live"]);
  expect(killCall!.env).toMatchObject(runtimeEnv);
});

test("dispose: does not invoke kill for a session already in terminal status", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  await writeFile(
    join(home, "sessions", "done.json"),
    JSON.stringify({ id: "done", status: "completed" })
  );

  const runner = new RecordingRunner();
  const clientPath = join(root, "fake-climon");

  const env = new HarnessEnvironment(
    makeInit(home, artifactRoot, {
      runner,
      artifacts: {
        clientPath,
        serverPath: join(root, "fake-server"),
        fixturePath: join(root, "harness", "fixtures", "echo-session.mjs"),
      },
    })
  );

  env.trackSession("done");
  await env.dispose().catch(() => {});

  const killCall = runner.calls.find(
    (c) => c.file === clientPath && c.args[0] === "kill"
  );
  expect(killCall).toBeUndefined();
});

test("dispose: terminates server via owned process handle", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  const serverProcess = makeOwnedProcess(12345);
  const env = new HarnessEnvironment(makeInit(home, artifactRoot, { serverProcess }));

  await env.dispose().catch(() => {});

  expect(serverProcess.killCount).toBeGreaterThan(0);
});

test("dispose: throws HarnessError cleanup when session wait times out", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  await writeFile(
    join(home, "sessions", "stuck.json"),
    JSON.stringify({ id: "stuck", status: "active" })
  );

  const env = new HarnessEnvironment(
    makeInit(home, artifactRoot, {
      sessionPollIntervalMs: 10,
      sessionWaitTimeoutMs: 100,
    })
  );

  env.trackSession("stuck");

  const err = await env.dispose().catch((e) => e);
  expect(err).toBeInstanceOf(HarnessError);
  expect((err as HarnessError).kind).toBe("cleanup");
});

test("dispose: is idempotent — second call does not throw additional errors", async () => {
  const { home, artifactRoot } = await makeTempDirs();
  const env = new HarnessEnvironment(makeInit(home, artifactRoot));

  await env.dispose().catch(() => {});
  // Second dispose should not throw or perform duplicate work
  await expect(env.dispose()).resolves.toBeUndefined();
});

// ── sessionMetaPath ──────────────────────────────────────────────────────────

test("sessionMetaPath: returns <home>/sessions/<id>.json", () => {
  const home = join(tmpdir(), "climon-path-test");
  const artifactRoot = join(tmpdir(), "climon-art-test");
  const env = new HarnessEnvironment(makeInit(home, artifactRoot));
  expect(env.sessionMetaPath("abc-123")).toBe(join(home, "sessions", "abc-123.json"));
});

// ── pollServerReady ──────────────────────────────────────────────────────────

const okFetch: FetchFn = async (_url) => ({
  ok: true,
  async json() { return { ok: true }; },
});

test("pollServerReady: resolves when server.json has valid pid/port and /health returns {ok:true}", async () => {
  const { home } = await makeTempDirs();
  const expectedPid = 5678;
  await writeFile(join(home, "server.json"), JSON.stringify({ pid: expectedPid, port: 9876 }));

  const result = await pollServerReady({
    home,
    expectedPid,
    pollIntervalMs: 10,
    timeoutMs: 2_000,
    fetch: okFetch,
  });

  expect(result).toEqual({ pid: expectedPid, port: 9876 });
});

test("pollServerReady: keeps polling while server.json has malformed content, resolves when valid", async () => {
  const { home } = await makeTempDirs();
  const expectedPid = 5678;
  const serverJsonPath = join(home, "server.json");
  await writeFile(serverJsonPath, "not-json");

  setTimeout(() => {
    void writeFile(serverJsonPath, JSON.stringify({ pid: expectedPid, port: 9876 }));
  }, 60);

  const result = await pollServerReady({
    home,
    expectedPid,
    pollIntervalMs: 15,
    timeoutMs: 2_000,
    fetch: okFetch,
  });

  expect(result.pid).toBe(expectedPid);
});

test("pollServerReady: keeps polling while /health returns non-ok response, resolves when healthy", async () => {
  const { home } = await makeTempDirs();
  const expectedPid = 5678;
  await writeFile(join(home, "server.json"), JSON.stringify({ pid: expectedPid, port: 9876 }));

  let callCount = 0;
  const flakeyFetch: FetchFn = async (_url) => {
    callCount++;
    if (callCount < 3) {
      return { ok: false, async json() { return {}; } };
    }
    return { ok: true, async json() { return { ok: true }; } };
  };

  const result = await pollServerReady({
    home,
    expectedPid,
    pollIntervalMs: 15,
    timeoutMs: 2_000,
    fetch: flakeyFetch,
  });

  expect(result.pid).toBe(expectedPid);
});

test("pollServerReady: keeps polling while /health body.ok is false, resolves when true", async () => {
  const { home } = await makeTempDirs();
  const expectedPid = 5678;
  await writeFile(join(home, "server.json"), JSON.stringify({ pid: expectedPid, port: 9876 }));

  let callCount = 0;
  const eventuallyOkFetch: FetchFn = async (_url) => {
    callCount++;
    const bodyOk = callCount >= 3;
    return { ok: true, async json() { return { ok: bodyOk }; } };
  };

  const result = await pollServerReady({
    home,
    expectedPid,
    pollIntervalMs: 15,
    timeoutMs: 2_000,
    fetch: eventuallyOkFetch,
  });

  expect(result.pid).toBe(expectedPid);
});

test("pollServerReady: throws HarnessError server-startup when timeout reached", async () => {
  const { home } = await makeTempDirs();
  // Never write server.json → polling never succeeds
  const err = await pollServerReady({
    home,
    expectedPid: 9999,
    pollIntervalMs: 10,
    timeoutMs: 150,
    fetch: okFetch,
  }).catch((e) => e);

  expect(err).toBeInstanceOf(HarnessError);
  expect((err as HarnessError).kind).toBe("server-startup");
});

