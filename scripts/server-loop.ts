#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";

/** Seconds to wait between server invocations. */
const RESTART_DELAY_SECONDS = 30;

const projectRoot = dirname(dirname(import.meta.path));
const serverEntrypoint = resolve(projectRoot, "src/server.ts");

let stopping = false;
let wakeFromDelay: (() => void) | undefined;

/**
 * Waits up to `ms`, but resolves early if `requestStop()` is called (so Ctrl-C
 * during the restart delay exits promptly instead of blocking the full delay).
 */
function interruptibleDelay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      wakeFromDelay = undefined;
      resolveDelay();
    }
    wakeFromDelay = finish;
  });
}

/**
 * Spawns one `bun src/server.ts server` run, forwarding any extra CLI args
 * (e.g. `--port 8080`), and resolves once that process exits. Inherits stdio so
 * the server's output is visible in this terminal.
 */
function runServerOnce(extraArgs: string[]): Promise<void> {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [serverEntrypoint, "server", ...extraArgs],
      { stdio: "inherit" },
    );

    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);

    child.on("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      const how = signal ? `signal ${signal}` : `code ${code ?? 0}`;
      process.stdout.write(`[server-loop] server exited (${how})\n`);
      resolveRun();
    });

    child.on("error", (err) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      process.stderr.write(`[server-loop] failed to start server: ${err.message}\n`);
      resolveRun();
    });
  });
}

/**
 * `bun run server:loop`: keep the dashboard server running. It launches
 * `bun src/server.ts server`, waits for it to exit, then waits
 * RESTART_DELAY_SECONDS and launches it again — forever — so the server is
 * automatically brought back up shortly after any shutdown or crash. Press
 * Ctrl-C (SIGINT) to stop the loop. Extra args are forwarded to the server,
 * e.g. `bun run server:loop -- --port 8080`.
 */
async function main(): Promise<void> {
  const extraArgs = process.argv.slice(2);

  const stop = () => {
    stopping = true;
    wakeFromDelay?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    await runServerOnce(extraArgs);
    if (stopping) break;
    process.stdout.write(
      `[server-loop] restarting in ${RESTART_DELAY_SECONDS}s (Ctrl-C to stop)\n`,
    );
    await interruptibleDelay(RESTART_DELAY_SECONDS * 1000);
  }

  process.stdout.write("[server-loop] stopped\n");
}

await main();
