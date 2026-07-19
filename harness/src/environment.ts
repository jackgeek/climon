import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { HarnessPlatform } from "./types.js";
import { HarnessError } from "./types.js";
import type { CommandRunner } from "./command.js";
import type { BuildArtifacts } from "./build.js";
import { buildHostArtifacts, planHostBuild, type StatFn } from "./build.js";
import { snapshotHome } from "./artifacts.js";
import { platformFromNode, processTreeTermination } from "./platform.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SessionMeta {
  id: string;
  status: string;
  exitCode?: number;
  name?: string;
}

export interface OwnedProcess {
  pid: number;
  kill(): void;
  wait(): Promise<number | null>;
}

export type FetchFn = (
  url: string
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface HarnessEnvironmentInit {
  root: string;
  platform: HarnessPlatform;
  home: string;
  artifactRoot: string;
  artifacts: BuildArtifacts;
  baseUrl: string;
  runner: CommandRunner;
  runtimeEnv: NodeJS.ProcessEnv;
  serverProcess: OwnedProcess;
  /** Polling interval for session status checks. Defaults to 100ms. */
  sessionPollIntervalMs?: number;
  /** Bounded wait for a tracked session to reach terminal state during dispose. Defaults to 30000ms. */
  sessionWaitTimeoutMs?: number;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "disconnected"]);

// ── parseServerState ─────────────────────────────────────────────────────────

export function parseServerState(
  raw: string
): { pid: number; port: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  const pid = obj.pid;
  const port = obj.port;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
    return undefined;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0)
    return undefined;
  return { pid, port };
}

// ── pollServerReady ──────────────────────────────────────────────────────────

export async function pollServerReady(opts: {
  home: string;
  expectedPid: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetch?: FetchFn;
}): Promise<{ pid: number; port: number }> {
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const fetchFn: FetchFn = opts.fetch ?? ((url) => fetch(url));
  const serverJsonPath = join(opts.home, "server.json");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const raw = await readFile(serverJsonPath, "utf8");
      const state = parseServerState(raw);
      if (state && state.pid === opts.expectedPid) {
        // Check /health endpoint
        const healthUrl = `http://127.0.0.1:${state.port}/health`;
        try {
          const res = await fetchFn(healthUrl);
          if (res.ok) {
            const body = await res.json();
            if (
              body !== null &&
              typeof body === "object" &&
              (body as Record<string, unknown>).ok === true
            ) {
              return state;
            }
          }
        } catch {
          // health check failed — keep polling
        }
      }
    } catch {
      // server.json not yet written — keep polling
    }
    await sleep(pollIntervalMs);
  }

  throw new HarnessError(
    "server-startup",
    `server did not become ready within ${timeoutMs}ms`
  );
}

// ── HarnessEnvironment ───────────────────────────────────────────────────────

export class HarnessEnvironment {
  readonly root: string;
  readonly platform: HarnessPlatform;
  readonly home: string;
  readonly artifactRoot: string;
  readonly artifacts: BuildArtifacts;
  readonly baseUrl: string;

  private readonly _runner: CommandRunner;
  private readonly _runtimeEnv: NodeJS.ProcessEnv;
  private readonly _serverProcess: OwnedProcess;
  private readonly _sessionPollIntervalMs: number;
  private readonly _sessionWaitTimeoutMs: number;
  private readonly _tracked: Set<string> = new Set();
  private _disposed = false;

  constructor(init: HarnessEnvironmentInit) {
    this.root = init.root;
    this.platform = init.platform;
    this.home = init.home;
    this.artifactRoot = init.artifactRoot;
    this.artifacts = init.artifacts;
    this.baseUrl = init.baseUrl;
    this._runner = init.runner;
    this._runtimeEnv = init.runtimeEnv;
    this._serverProcess = init.serverProcess;
    this._sessionPollIntervalMs = init.sessionPollIntervalMs ?? 100;
    this._sessionWaitTimeoutMs = init.sessionWaitTimeoutMs ?? 30_000;
  }

  // ── Factory ────────────────────────────────────────────────────────────────

  static async create(opts: {
    root: string;
    platform?: HarnessPlatform;
    artifactRoot: string;
    runner: CommandRunner;
    spawnServer?: (o: {
      file: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      stdoutPath: string;
      stderrPath: string;
    }) => OwnedProcess;
    stat?: StatFn;
    fetch?: FetchFn;
  }): Promise<HarnessEnvironment> {
    const platform = opts.platform ?? platformFromNode(process.platform);
    const runtimeDir = join(opts.artifactRoot, "runtime");
    const home = join(runtimeDir, "home");
    const logsDir = join(runtimeDir, "logs");
    const buildDir = join(runtimeDir, "build");

    await mkdir(home, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });

    // Write config.jsonc disabling telemetry and update
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify(
        {
          telemetry: { enabled: false },
          update: { auto: false },
          remote: { enabled: false, autoLink: false },
        },
        null,
        2
      ) + "\n"
    );

    // Construct runtime env
    const runtimeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CLIMON_HOME: home,
      CLIMON_COLS: "100",
      CLIMON_ROWS: "30",
      CI: "true",
      NO_COLOR: "1",
    };
    delete runtimeEnv.APPLICATIONINSIGHTS_CONNECTION_STRING;

    // Build artifacts
    const plan = planHostBuild(opts.root, buildDir, platform);
    const artifacts = await buildHostArtifacts(plan, opts.runner, opts.stat);

    // CLIMON_CLIENT_BIN set after build so we have the actual path
    runtimeEnv.CLIMON_CLIENT_BIN = artifacts.clientPath;

    // Spawn server
    const serverStdoutPath = join(logsDir, "server-stdout.log");
    const serverStderrPath = join(logsDir, "server-stderr.log");

    let serverProcess: OwnedProcess;
    if (opts.spawnServer) {
      serverProcess = opts.spawnServer({
        file: artifacts.serverPath,
        args: ["server", "--no-takeover", "--port", "0"],
        env: runtimeEnv,
        stdoutPath: serverStdoutPath,
        stderrPath: serverStderrPath,
      });
    } else {
      serverProcess = defaultSpawnServer({
        file: artifacts.serverPath,
        args: ["server", "--no-takeover", "--port", "0"],
        env: runtimeEnv,
        stdoutPath: serverStdoutPath,
        stderrPath: serverStderrPath,
        platform,
      });
    }

    // Poll for readiness
    let serverState: { pid: number; port: number };
    try {
      serverState = await pollServerReady({
        home,
        expectedPid: serverProcess.pid,
        timeoutMs: 30_000,
        fetch: opts.fetch,
      });
    } catch (err) {
      serverProcess.kill();
      await serverProcess.wait().catch(() => {});
      throw new HarnessError(
        "server-startup",
        `server did not become ready: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    const baseUrl = `http://127.0.0.1:${serverState.port}`;

    return new HarnessEnvironment({
      root: opts.root,
      platform,
      home,
      artifactRoot: opts.artifactRoot,
      artifacts,
      baseUrl,
      runner: opts.runner,
      runtimeEnv,
      serverProcess,
    });
  }

  // ── Methods ────────────────────────────────────────────────────────────────

  trackSession(id: string): void {
    this._tracked.add(id);
  }

  sessionMetaPath(id: string): string {
    return join(this.home, "sessions", `${id}.json`);
  }

  async readSessionMeta(id: string): Promise<SessionMeta> {
    const filePath = this.sessionMetaPath(id);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      throw new HarnessError(
        "assertion",
        `could not read session meta for ${id}: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HarnessError("assertion", `malformed session JSON for ${id}`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new HarnessError("assertion", `session meta for ${id} is not an object`);
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.id !== id) {
      throw new HarnessError(
        "assertion",
        `session meta id mismatch: expected "${id}", got "${String(obj.id)}"`
      );
    }
    if (typeof obj.status !== "string" || obj.status === "") {
      throw new HarnessError(
        "assertion",
        `session meta for ${id} has invalid or missing status`
      );
    }
    const meta: SessionMeta = { id, status: obj.status };
    if (typeof obj.exitCode === "number") meta.exitCode = obj.exitCode;
    if (typeof obj.name === "string") meta.name = obj.name;
    return meta;
  }

  async waitForSessionStatus(
    id: string,
    expectedStatus: string,
    timeoutMs = 30_000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const meta = await this.readSessionMeta(id);
        if (meta.status === expectedStatus) return;
      } catch {
        // file may not exist yet — keep polling
      }
      await sleep(this._sessionPollIntervalMs);
    }
    throw new HarnessError(
      "timeout",
      `session ${id} did not reach status "${expectedStatus}" within ${timeoutMs}ms`
    );
  }

  async findSessionIdByName(name: string, timeoutMs = 30_000): Promise<string> {
    const sessionsDir = join(this.home, "sessions");
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      let entries: string[];
      try {
        entries = await readdir(sessionsDir);
      } catch {
        entries = [];
      }

      const matches: string[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(sessionsDir, entry), "utf8");
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (typeof parsed.name === "string" && parsed.name === name) {
            if (typeof parsed.id === "string") {
              matches.push(parsed.id);
            }
          }
        } catch {
          // ignore malformed files
        }
      }

      if (matches.length > 1) {
        throw new HarnessError(
          "assertion",
          `found ${matches.length} sessions named "${name}": ${matches.join(", ")}`
        );
      }
      if (matches.length === 1) return matches[0];

      await sleep(this._sessionPollIntervalMs);
    }

    throw new HarnessError(
      "timeout",
      `no session named "${name}" found within ${timeoutMs}ms`
    );
  }

  async snapshotState(destination: string): Promise<void> {
    await snapshotHome(this.home, destination);
  }

  private async _waitForAnyTerminalStatus(id: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const meta = await this.readSessionMeta(id);
        if (TERMINAL_STATUSES.has(meta.status)) return;
      } catch {
        // file may not be present yet — keep polling
      }
      await sleep(this._sessionPollIntervalMs);
    }
    throw new HarnessError(
      "timeout",
      `session ${id} did not reach terminal status within ${timeoutMs}ms`
    );
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;

    const errors: string[] = [];

    // Kill non-terminal tracked sessions
    for (const id of this._tracked) {
      try {
        const meta = await this.readSessionMeta(id).catch(() => null);
        if (meta && TERMINAL_STATUSES.has(meta.status)) continue;

        // Invoke clientPath kill <id> with isolated runtime env
        await this._runner.run({
          file: this.artifacts.clientPath,
          args: ["kill", id],
          cwd: this.root,
          env: { ...this._runtimeEnv },
          timeoutMs: 15_000,
          stdoutPath: join(this.artifactRoot, "runtime", "logs", `kill-${id}-stdout.log`),
          stderrPath: join(this.artifactRoot, "runtime", "logs", `kill-${id}-stderr.log`),
        });
      } catch (err) {
        errors.push(
          `session kill ${id}: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }

      // Wait for any terminal status (bounded)
      try {
        await this._waitForAnyTerminalStatus(id, this._sessionWaitTimeoutMs);
      } catch (err) {
        errors.push(
          `session ${id} did not reach terminal status: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Terminate server
    try {
      this._serverProcess.kill();
      await Promise.race([
        this._serverProcess.wait(),
        sleep(5_000),
      ]);
    } catch (err) {
      errors.push(
        `server termination: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Snapshot final state
    try {
      const dest = join(this.artifactRoot, "runtime", "climon-home");
      await mkdir(dest, { recursive: true });
      await this.snapshotState(dest);
    } catch (err) {
      errors.push(
        `snapshot: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (errors.length > 0) {
      throw new HarnessError("cleanup", errors.join("; "));
    }
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawnServer(opts: {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  platform: HarnessPlatform;
}): OwnedProcess {
  const stdoutWs = createWriteStream(opts.stdoutPath);
  const stderrWs = createWriteStream(opts.stderrPath);

  const isUnix = opts.platform !== "windows";
  const child = spawn(opts.file, opts.args, {
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: isUnix,
  });

  child.stdout?.pipe(stdoutWs);
  child.stderr?.pipe(stderrWs);

  if (isUnix && child.pid !== undefined) {
    child.unref();
  }

  const pid = child.pid ?? 0;

  return {
    pid,
    kill() {
      const term = processTreeTermination(opts.platform, pid, false);
      try {
        if ("signal" in term) {
          process.kill(term.pid, term.signal);
        } else {
          spawn(term.file, term.args, { stdio: "ignore" });
        }
      } catch {
        // already gone
      }
    },
    wait() {
      return new Promise<number | null>((resolve) => {
        child.once("close", (code) => resolve(code));
      });
    },
  };
}
