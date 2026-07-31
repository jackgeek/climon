import { open, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
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

function collectStream(
  stream: WebReadableStream<Uint8Array>,
  path: string
) : StreamCollector {
  const reader = stream.getReader();
  let aborted = false;

  const promise = (async (): Promise<string> => {
    await mkdir(dirname(path), { recursive: true });
    const file = await open(path, "w");
    const decoder = new TextDecoder();
    let output = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        if (value === undefined) {
          continue;
        }

        const bytes = value instanceof Uint8Array ? value : Buffer.from(value);
        await file.write(bytes);
        output += decoder.decode(bytes, { stream: true });
      }

      output += decoder.decode();
      return output;
    } catch (error) {
      if (!aborted) {
        throw error;
      }

      output += decoder.decode();
      return output;
    } finally {
      reader.releaseLock();
      await file.close();
    }
  })();

  return {
    promise,
    async abort() {
      if (aborted) {
        return;
      }

      aborted = true;
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation errors while timing out.
      }
    },
  };
}

export class BunCommandRunner implements CommandRunner {
  public async run(spec: CommandSpec): Promise<CommandResult> {
    const startedAt = performance.now();
    const spawnOptions = {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    };
    let subprocess: ReturnType<typeof Bun.spawn>;
    try {
      subprocess = Bun.spawn(
        [spec.file, ...spec.args],
        spawnOptions as Parameters<typeof Bun.spawn>[1]
      );
    } catch (error) {
      throw new HarnessError(
        "prerequisite",
        `Failed to start command: ${spec.file} ${spec.args.join(" ")}`,
        { cause: error }
      );
    }

    const stdoutCollector = collectStream(
      subprocess.stdout as unknown as WebReadableStream<Uint8Array>,
      spec.stdoutPath
    );
    const stderrCollector = collectStream(
      subprocess.stderr as unknown as WebReadableStream<Uint8Array>,
      spec.stderrPath
    );
    const completionPromise = Promise.all([
      subprocess.exited,
      Promise.all([
        stdoutCollector.promise,
        stderrCollector.promise,
      ]),
    ]).then(([code, [stdout, stderr]]) => {
      return { code, stdout, stderr };
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
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
              timedOut = true;
              elapsedAtTimeout = Math.round(performance.now() - startedAt);
              try {
                subprocess.kill("SIGKILL");
              } catch {
                // Ignore kill errors when the process already exited.
              }
              await Promise.allSettled([
                stdoutCollector.abort(),
                stderrCollector.abort(),
                subprocess.exited,
              ]);
              resolve({ timedOut: true });
            })();
          }, spec.timeoutMs);
        }),
      ]);

      if (exit.timedOut || timedOut) {
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
        subprocess.exited,
      ]);
      throw error;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }

      await Promise.allSettled([
        completionPromise,
        stdoutCollector.promise,
        stderrCollector.promise,
      ]);
    }
  }
}
