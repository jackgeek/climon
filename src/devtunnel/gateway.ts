import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyDevtunnelFailure } from "./classify.js";
import { DevtunnelError, type DevtunnelFailure, type DevtunnelHealth, type DevtunnelOperation } from "./types.js";
import {
  defaultRawDevtunnelProcessSpawner,
  startDevtunnelProcess,
  type DevtunnelProcess,
  type DevtunnelProcessHandlers,
  type RawDevtunnelProcessSpawner
} from "./process.js";

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

export interface DevtunnelGateway {
  detect(): Promise<DevtunnelHealth>;
  showUser(): Promise<DevtunnelHealth>;
  listTunnels(args?: { labels?: string[] }): Promise<unknown>;
  showTunnel(id: string, verbose?: boolean): Promise<unknown>;
  createTunnel(args: { id?: string; labels?: string[]; description?: string }): Promise<RunResult>;
  deleteTunnel(id: string, force?: boolean): Promise<void>;
  listPorts(id: string): Promise<RunResult>;
  createPort(id: string, port: number, protocol?: "http"): Promise<void>;
  deletePort(id: string, port: number): Promise<void>;
  spawnHost(id: string): DevtunnelProcess;
}

export function devtunnelEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (env.LD_LIBRARY_PATH) return env;
  const icuLib = join(env.HOME ?? homedir(), ".local", "icu", "usr", "lib", "x86_64-linux-gnu");
  return existsSync(icuLib) ? { ...env, LD_LIBRARY_PATH: icuLib } : env;
}

export function isDevtunnelDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CLIMON_DISABLE_DEVTUNNEL;
  return v === "1" || v === "true";
}

export interface DevtunnelGatewayDeps {
  runner?: Runner;
  processSpawner?: (cmd: string, args: string[], handlers: DevtunnelProcessHandlers) => DevtunnelProcess;
  rawProcessSpawner?: RawDevtunnelProcessSpawner;
  processHandlers?: DevtunnelProcessHandlers;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

function health(input: Partial<DevtunnelHealth>, now: Date): DevtunnelHealth {
  return {
    available: false,
    authenticated: false,
    state: "idle",
    probedAt: now.toISOString(),
    ...input
  };
}

function defaultRunnerFor(env: NodeJS.ProcessEnv): Runner {
  return (cmd, args) => new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: cmd === "devtunnel" ? devtunnelEnv(env) : env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", (err: NodeJS.ErrnoException) => finish({
      status: 127,
      stdout,
      stderr: stderr || err.message,
      spawnError: err.code ?? err.message
    }));
    child.on("close", (code) => finish({ status: code ?? 1, stdout, stderr }));
  });
}

function classify(operation: DevtunnelOperation, result: RunResult, now: Date, parseFailed = false): DevtunnelFailure {
  return classifyDevtunnelFailure({
    operation,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    spawnError: result.spawnError,
    parseFailed
  }, now);
}

function parseJson(operation: DevtunnelOperation, result: RunResult, now: Date): unknown {
  try {
    return JSON.parse(result.stdout || "null");
  } catch {
    throw new DevtunnelError(classify(operation, result, now, true));
  }
}

function throwFailure(operation: DevtunnelOperation, result: RunResult, now: Date): never {
  throw new DevtunnelError(classify(operation, result, now));
}

function disabledResult(): RunResult {
  return { status: 127, stdout: "", stderr: "devtunnel disabled", spawnError: "ENOENT" };
}

function isLoggedInStatus(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const status = String((value as { status?: unknown }).status ?? "");
  return /logged\s+in/i.test(status) && !/not\s+logged\s+in/i.test(status);
}

export function createDevtunnelGateway(deps: DevtunnelGatewayDeps = {}): DevtunnelGateway {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const runner = deps.runner ?? defaultRunnerFor(env);
  const run = async (operation: DevtunnelOperation, args: string[]): Promise<RunResult> => {
    if (isDevtunnelDisabled(env)) throwFailure(operation, disabledResult(), now());
    const result = await runner("devtunnel", args);
    if (result.status !== 0) throwFailure(operation, result, now());
    return result;
  };

  return {
    async detect() {
      if (isDevtunnelDisabled(env)) return health({ available: false }, now());
      const result = await runner("devtunnel", ["--version"]);
      if (result.status !== 0) {
        const failure = classify("detect", result, now());
        return health({ available: false, lastFailure: failure }, now());
      }
      return health({ available: true, version: result.stdout.trim() || undefined }, now());
    },

    async showUser() {
      if (isDevtunnelDisabled(env)) return health({ available: false }, now());
      const result = await runner("devtunnel", ["user", "show", "--json"]);
      if (result.status !== 0) return health({ available: true, lastFailure: classify("show-user", result, now()) }, now());
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout || "null");
      } catch {
        return health({ available: true, lastFailure: classify("show-user", result, now(), true) }, now());
      }
      if (isLoggedInStatus(parsed)) return health({ available: true, authenticated: true }, now());
      const failure = classify("show-user", { ...result, status: 1, stderr: result.stderr || result.stdout || "Not logged in" }, now());
      return health({ available: true, authenticated: false, lastFailure: failure }, now());
    },

    async listTunnels(args = {}) {
      const cmdArgs = ["list", "--json"];
      if (args.labels?.length) cmdArgs.push("--labels", args.labels.join(","));
      const result = await run("list-tunnels", cmdArgs);
      return parseJson("list-tunnels", result, now());
    },

    async showTunnel(id, verbose = false) {
      const result = await run("show-tunnel", ["show", id, ...(verbose ? ["--verbose"] : []), "--json"]);
      return parseJson("show-tunnel", result, now());
    },

    async createTunnel(args) {
      const cmdArgs = ["create"];
      if (args.id) cmdArgs.push(args.id);
      for (const label of args.labels ?? []) cmdArgs.push("--labels", label);
      if (args.description) cmdArgs.push("--description", args.description);
      cmdArgs.push("--json");
      return run("create-tunnel", cmdArgs);
    },

    async deleteTunnel(id, force = false) {
      await run("delete-tunnel", ["delete", id, ...(force ? ["--force"] : [])]);
    },

    async listPorts(id) {
      return run("list-ports", ["port", "list", id, "--json"]);
    },

    async createPort(id, port, protocol) {
      const args = ["port", "create", id, "-p", String(port)];
      if (protocol) args.push("--protocol", protocol);
      if (isDevtunnelDisabled(env)) throw new DevtunnelError(classify("create-port", disabledResult(), now()));
      const result = await runner("devtunnel", args);
      if (result.status === 0) return;
      const failure = classify("create-port", result, now());
      if (failure.code === "port_conflict") return;
      throw new DevtunnelError(failure);
    },

    async deletePort(id, port) {
      await run("delete-port", ["port", "delete", id, "-p", String(port)]);
    },

    spawnHost(id) {
      if (isDevtunnelDisabled(env)) {
        return { stop: () => {}, isAlive: () => false };
      }
      const handlers = deps.processHandlers ?? { onStdout() {}, onStderr() {}, onExit() {} };
      if (deps.processSpawner) return deps.processSpawner("devtunnel", ["host", id], handlers);
      return startDevtunnelProcess("devtunnel", ["host", id], deps.rawProcessSpawner ?? defaultRawDevtunnelProcessSpawner, handlers, {
        env: devtunnelEnv(env),
        now,
        operation: "host-tunnel"
      });
    }
  };
}
