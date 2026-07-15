import { spawn } from "node:child_process";
import type { DevtunnelFailure, DevtunnelOperation } from "./types.js";
import { classifyDevtunnelFailure } from "./classify.js";

export interface DevtunnelProcessHandlers {
  onStdout(text: string): void;
  onStderr(text: string): void;
  onExit(failure?: DevtunnelFailure): void;
}

export interface DevtunnelProcess {
  stop(): void;
  isAlive(): boolean;
}

export interface RawDevtunnelProcessExit {
  status: number | null;
  stdout?: string;
  stderr?: string;
  spawnError?: string;
}

export interface RawDevtunnelProcessHandlers {
  onStdout(text: string): void;
  onStderr(text: string): void;
  onExit(result: RawDevtunnelProcessExit): void;
}

export type RawDevtunnelProcessSpawner = (
  cmd: string,
  args: string[],
  handlers: RawDevtunnelProcessHandlers,
  options?: { env?: NodeJS.ProcessEnv }
) => DevtunnelProcess;

export function startDevtunnelProcess(
  cmd: string,
  args: string[],
  rawSpawner: RawDevtunnelProcessSpawner,
  handlers: DevtunnelProcessHandlers,
  options: { env?: NodeJS.ProcessEnv; now?: () => Date; operation?: DevtunnelOperation } = {}
): DevtunnelProcess {
  let alive = true;
  let stdout = "";
  let stderr = "";
  let exited = false;
  const finish = (result: RawDevtunnelProcessExit) => {
    if (exited) return;
    exited = true;
    alive = false;
    const status = result.status ?? 1;
    const finalStdout = result.stdout ?? stdout;
    const finalStderr = result.stderr ?? stderr;
    if (status === 0) {
      handlers.onExit();
      return;
    }
    handlers.onExit(classifyDevtunnelFailure({
      operation: options.operation ?? "host-tunnel",
      status,
      stdout: finalStdout,
      stderr: finalStderr,
      spawnError: result.spawnError
    }, options.now?.() ?? new Date()));
  };

  const process = rawSpawner(cmd, args, {
    onStdout(text) {
      stdout += text;
      handlers.onStdout(text);
    },
    onStderr(text) {
      stderr += text;
      handlers.onStderr(text);
    },
    onExit: finish
  }, { env: options.env });

  return {
    stop() {
      if (!alive) return;
      process.stop();
    },
    isAlive() {
      return alive && process.isAlive();
    }
  };
}

export const defaultRawDevtunnelProcessSpawner: RawDevtunnelProcessSpawner = (cmd, args, handlers, options) => {
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: options?.env ?? process.env,
    windowsHide: true
  });
  let alive = true;
  let stdout = "";
  let stderr = "";
  let exited = false;
  const finish = (result: RawDevtunnelProcessExit) => {
    if (exited) return;
    exited = true;
    alive = false;
    handlers.onExit(result);
  };
  child.stdout.on("data", (b: Buffer) => {
    const text = b.toString("utf8");
    stdout += text;
    handlers.onStdout(text);
  });
  child.stderr.on("data", (b: Buffer) => {
    const text = b.toString("utf8");
    stderr += text;
    handlers.onStderr(text);
  });
  child.on("error", (err: NodeJS.ErrnoException) => {
    finish({ status: 127, stdout, stderr: stderr || err.message, spawnError: err.code ?? err.message });
  });
  child.on("close", (code) => finish({ status: code ?? 1, stdout, stderr }));
  return {
    stop() {
      if (!alive) return;
      child.kill();
    },
    isAlive() {
      return alive;
    }
  };
};
