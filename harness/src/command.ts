import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { HarnessPlatform } from "./types.js";
import { HarnessError } from "./types.js";
import { platformFromNode } from "./platform.js";

export interface CommandSpec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdoutPath: string;
  stderrPath: string;
  detached?: boolean;
}

export interface CommandResult {
  code: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>;
}

const MAX_RETAINED_BYTES = 1 * 1024 * 1024; // 1 MiB

class TailBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
    while (this.totalBytes > MAX_RETAINED_BYTES && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      this.totalBytes -= removed.length;
    }
  }

  toString(): string {
    const combined = Buffer.concat(this.chunks);
    if (combined.length > MAX_RETAINED_BYTES) {
      return combined
        .subarray(combined.length - MAX_RETAINED_BYTES)
        .toString("utf8");
    }
    return combined.toString("utf8");
  }
}

function spawnTaskkill(pid: number, force: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const tk = spawn("taskkill", args, { stdio: "ignore" });
    const done = () => resolve();
    tk.on("close", done);
    tk.on("error", done);
    setTimeout(done, 5_000);
  });
}

function raceClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const onClose = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    child.once("close", onClose);
  });
}

async function terminateOwned(
  child: ChildProcess,
  pid: number,
  detached: boolean,
  platform: HarnessPlatform
): Promise<void> {
  // Initiate graceful termination
  if (platform === "windows") {
    await spawnTaskkill(pid, false);
  } else {
    const target = detached ? -pid : pid;
    try {
      process.kill(target, "SIGTERM");
    } catch {
      // process may have already exited
    }
  }

  // Wait up to 2s for child to close on its own
  const closed = await raceClose(child, 2_000);

  if (!closed) {
    // Force-kill the owned process tree
    if (platform === "windows") {
      await spawnTaskkill(pid, true);
    } else {
      const target = detached ? -pid : pid;
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // already gone
      }
    }
    // Short bounded wait for close after force-kill
    await raceClose(child, 500);
  }
}

export function createCommandRunner(): CommandRunner {
  const platform = platformFromNode(process.platform);
  return {
    async run(spec: CommandSpec): Promise<CommandResult> {
      await mkdir(dirname(spec.stdoutPath), { recursive: true });
      await mkdir(dirname(spec.stderrPath), { recursive: true });

      const stdoutWs = createWriteStream(spec.stdoutPath);
      const stderrWs = createWriteStream(spec.stderrPath);
      const stdoutBuf = new TailBuffer();
      const stderrBuf = new TailBuffer();

      const detached = spec.detached ?? false;
      const start = Date.now();

      const child = spawn(spec.file, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached,
      });

      child.stdout!.on("data", (chunk: Buffer) => {
        stdoutBuf.push(chunk);
        stdoutWs.write(chunk);
      });

      child.stderr!.on("data", (chunk: Buffer) => {
        stderrBuf.push(chunk);
        stderrWs.write(chunk);
      });

      return new Promise<CommandResult>((resolve, reject) => {
        let settled = false;
        let timedOut = false;

        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          stdoutWs.end();
          stderrWs.end();
          fn();
        };

        const timer = setTimeout(() => {
          timedOut = true;
          const pid = child.pid;
          void (async () => {
            if (pid !== undefined) {
              await terminateOwned(child, pid, detached, platform).catch(
                () => {}
              );
            }
            settle(() =>
              reject(
                new HarnessError(
                  "timeout",
                  `command timed out after ${spec.timeoutMs}ms: ${spec.file}`
                )
              )
            );
          })();
        }, spec.timeoutMs);

        child.on("error", (err) => {
          clearTimeout(timer);
          settle(() =>
            reject(
              new HarnessError(
                "build",
                `spawn error for ${spec.file}: ${err.message}`,
                err
              )
            )
          );
        });

        child.on("close", (code, signal) => {
          clearTimeout(timer);
          if (timedOut) return;
          const durationMs = Date.now() - start;
          if (code === 0) {
            settle(() =>
              resolve({
                code: 0,
                signal: null,
                durationMs,
                stdout: stdoutBuf.toString(),
                stderr: stderrBuf.toString(),
              })
            );
          } else {
            settle(() =>
              reject(
                new HarnessError(
                  "build",
                  `process exited with code ${String(code)}: ${spec.file} ${spec.args.join(" ")}`,
                  {
                    executable: spec.file,
                    args: spec.args,
                    code,
                    signal,
                    stdoutPath: spec.stdoutPath,
                    stderrPath: spec.stderrPath,
                  }
                )
              )
            );
          }
        });
      });
    },
  };
}
