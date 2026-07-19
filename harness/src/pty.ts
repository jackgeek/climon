import { spawn as ptySpawn } from "node-pty";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { HarnessError } from "./types.js";

// ── Public interface ──────────────────────────────────────────────────────────

export interface PtySession {
  readonly output: string;
  writeLine(line: string): void;
  waitFor(marker: string, timeoutMs: number): Promise<void>;
  waitForExit(timeoutMs: number): Promise<number>;
  kill(): void;
}

export interface PtySessionOptions {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  logPath: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip undefined values so node-pty receives only string entries. */
function toDefinedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}

/** Normalise CRLF → LF for marker matching only; raw bytes are preserved. */
function normaliseForMarker(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/** Last N chars of a string, for bounded recent-output snippets in errors. */
function tail(s: string, n = 512): string {
  return s.length > n ? s.slice(s.length - n) : s;
}

// ── spawnPtySession ───────────────────────────────────────────────────────────

export async function spawnPtySession(
  opts: PtySessionOptions
): Promise<PtySession> {
  await mkdir(dirname(opts.logPath), { recursive: true });
  const logStream = createWriteStream(opts.logPath, { flags: "a" });

  const pty = ptySpawn(opts.file, opts.args, {
    name: "xterm-256color",
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 30,
    cwd: opts.cwd,
    env: toDefinedEnv(opts.env),
  });

  let rawOutput = "";
  let exitCode: number | undefined;
  let dead = false;

  // Pending waitFor listeners: each holds the normalised marker and resolve/reject
  type Waiter = {
    normMarker: string;
    resolve: () => void;
    reject: (e: unknown) => void;
  };
  const waiters: Waiter[] = [];

  // Pending waitForExit listeners
  type ExitWaiter = {
    resolve: (code: number) => void;
    reject: (e: unknown) => void;
  };
  const exitWaiters: ExitWaiter[] = [];

  pty.onData((data: string) => {
    rawOutput += data;
    logStream.write(data);
    const normed = normaliseForMarker(rawOutput);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (normed.includes(waiters[i].normMarker)) {
        const w = waiters.splice(i, 1)[0];
        w.resolve();
      }
    }
  });

  pty.onExit(({ exitCode: code }) => {
    dead = true;
    exitCode = code;
    logStream.end();
    // Drain remaining waiters as failures if they haven't resolved
    for (const w of waiters.splice(0)) {
      w.reject(
        new HarnessError(
          "pty",
          `PTY exited (code ${code}) before marker was seen: ${w.normMarker}`
        )
      );
    }
    for (const w of exitWaiters.splice(0)) {
      w.resolve(code);
    }
  });

  return {
    get output() {
      return rawOutput;
    },

    writeLine(line: string): void {
      pty.write(`${line}\r`);
    },

    waitFor(marker: string, timeoutMs: number): Promise<void> {
      const normMarker = normaliseForMarker(marker);
      // Check existing buffer first
      if (normaliseForMarker(rawOutput).includes(normMarker)) {
        return Promise.resolve();
      }
      if (dead) {
        return Promise.reject(
          new HarnessError(
            "pty",
            `PTY already exited; marker not found: ${marker}`
          )
        );
      }
      return new Promise<void>((resolve, reject) => {
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const idx = waiters.findIndex((w) => w.resolve === safeResolve);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(
            new HarnessError(
              "timeout",
              `timed out after ${timeoutMs}ms waiting for marker ${JSON.stringify(marker)}; recent output: ${JSON.stringify(tail(rawOutput))}`
            )
          );
        }, timeoutMs);

        const safeResolve = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };

        const safeReject = (e: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        };

        waiters.push({ normMarker, resolve: safeResolve, reject: safeReject });
      });
    },

    waitForExit(timeoutMs: number): Promise<number> {
      if (exitCode !== undefined) {
        return Promise.resolve(exitCode);
      }
      return new Promise<number>((resolve, reject) => {
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const idx = exitWaiters.findIndex((w) => w.resolve === safeResolve);
          if (idx !== -1) exitWaiters.splice(idx, 1);
          reject(
            new HarnessError(
              "timeout",
              `timed out after ${timeoutMs}ms waiting for PTY exit`
            )
          );
        }, timeoutMs);

        const safeResolve = (code: number) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(code);
        };

        const safeReject = (e: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        };

        exitWaiters.push({ resolve: safeResolve, reject: safeReject });
      });
    },

    kill(): void {
      if (dead) return;
      try {
        pty.kill();
      } catch {
        // already dead
      }
    },
  };
}
