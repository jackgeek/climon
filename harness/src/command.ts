import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { HarnessError } from "./types.js";

export interface CommandSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  stdoutPath: string;
  stderrPath: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>;
}

interface StreamCollector {
  promise: Promise<string>;
  abort(): Promise<void>;
}

function emptyCollector(path: string): StreamCollector {
  return {
    promise: (async () => {
      await mkdir(dirname(path), { recursive: true });
      const file = await open(path, "w");
      await file.close();
      return "";
    })(),
    async abort() {},
  };
}

function collectStream(stream: Readable | null, path: string): StreamCollector {
  if (stream === null) {
    return emptyCollector(path);
  }

  let aborted = false;
  let settled = false;
  let output = "";
  const decoder = new TextDecoder();
  let writeQueue = Promise.resolve();
  let finalize:
    | ((error?: unknown) => Promise<void>)
    | undefined;

  const promise = new Promise<string>((resolve, reject) => {
    void (async () => {
      try {
        await mkdir(dirname(path), { recursive: true });
        const file = await open(path, "w");
        const onData = (chunk: string | Buffer) => {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          writeQueue = writeQueue.then(async () => {
            await file.write(bytes);
            output += decoder.decode(bytes, { stream: true });
          });
        };
        const onEnd = () => {
          void finalize?.();
        };
        const onClose = () => {
          if (aborted) {
            void finalize?.();
          }
        };
        const onError = (error: unknown) => {
          void finalize?.(error);
        };

        finalize = async (error?: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          stream.off("data", onData);
          stream.off("end", onEnd);
          stream.off("close", onClose);
          stream.off("error", onError);
          await writeQueue.catch(() => undefined);
          output += decoder.decode();
          await file.close();
          if (error === undefined || aborted) {
            resolve(output);
            return;
          }
          reject(error);
        };

        stream.on("data", onData);
        stream.on("end", onEnd);
        stream.on("close", onClose);
        stream.on("error", onError);
      } catch (error) {
        settled = true;
        reject(error);
      }
    })();
  });

  return {
    promise,
    async abort() {
      if (aborted || settled) {
        return;
      }
      aborted = true;
      stream.destroy();
      await finalize?.();
    },
  };
}

export class BunCommandRunner implements CommandRunner {
  public async run(spec: CommandSpec): Promise<CommandResult> {
    const startedAt = performance.now();
    let subprocess;

    try {
      subprocess = spawn(spec.file, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new HarnessError(
        "prerequisite",
        `Failed to start command: ${spec.file} ${spec.args.join(" ")}`,
        { cause: error }
      );
    }

    const stdoutCollector = collectStream(subprocess.stdout, spec.stdoutPath);
    const stderrCollector = collectStream(subprocess.stderr, spec.stderrPath);
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        subprocess.once("error", (error) => {
          reject(
            new HarnessError(
              "prerequisite",
              `Failed to start command: ${spec.file} ${spec.args.join(" ")}`,
              { cause: error }
            )
          );
        });
        subprocess.once("exit", (code, signal) => {
          resolve({ code, signal });
        });
      }
    );
    const closePromise = new Promise<void>((resolve) => {
      subprocess.once("error", (error) => {
        void error;
        resolve();
      });
      subprocess.once("close", () => {
        resolve();
      });
    });
    const completionPromise = Promise.all([
      exitPromise,
      closePromise,
      stdoutCollector.promise,
      stderrCollector.promise,
    ]).then(([exit, , stdout, stderr]) => ({
      code: exit.code ?? 0,
      signal: exit.signal,
      stdout,
      stderr,
    }));

    let timer: ReturnType<typeof setTimeout> | undefined;
    let elapsedAtTimeout = 0;

    try {
      const exit = await Promise.race([
        completionPromise.then((result) => ({
          timedOut: false as const,
          ...result,
        })),
        new Promise<{ timedOut: true }>((resolve) => {
          timer = setTimeout(() => {
            void (async () => {
              elapsedAtTimeout = Math.round(performance.now() - startedAt);
              try {
                subprocess.kill("SIGKILL");
              } catch {
                // Ignore kill errors when the process already exited.
              }
              await Promise.allSettled([
                stdoutCollector.abort(),
                stderrCollector.abort(),
                exitPromise,
              ]);
              resolve({ timedOut: true });
            })();
          }, spec.timeoutMs);
        }),
      ]);

      if (exit.timedOut) {
        throw new HarnessError(
          "timeout",
          `Command timed out after ${elapsedAtTimeout}ms: ${spec.file} ${spec.args.join(" ")}`
        );
      }

      return {
        code: exit.code,
        stdout: exit.stdout,
        stderr: exit.stderr,
        durationMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      try {
        subprocess.kill("SIGKILL");
      } catch {
        // The process may already have exited.
      }
      await Promise.allSettled([
        stdoutCollector.abort(),
        stderrCollector.abort(),
        exitPromise,
        closePromise,
      ]);
      throw error;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
