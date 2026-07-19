// Shared helpers for tests that spawn the Bun dashboard server (src/server.ts).
//
// These tests each cold-start the full dashboard import graph (React, Fluent UI,
// xterm, ...), which is slow on a loaded CI runner. Centralizing the spawn/wait
// helpers here keeps the readiness timeout generous and, crucially, makes a real
// failure diagnosable: waitForHealth fails fast with the server's captured stderr
// when the process exits early, instead of every caller silently timing out.
import { createServer } from "node:net";

/** Reserve an ephemeral loopback port and return it (the listener is closed). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** Poll `fn` until it resolves a defined value or `ms` elapses. */
export async function waitFor<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  ms = 30000
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await Promise.race([
      Promise.resolve().then(fn).catch(() => undefined),
      new Promise<undefined>((resolve) => setTimeout(resolve, 1000, undefined))
    ]);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}

/** Resolve true if the process exits within `ms`, false otherwise. */
export async function waitForExit(server: Bun.Subprocess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(false);
    }, ms);
    void server.exited.finally(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function drainStderr(server: Bun.Subprocess): Promise<string> {
  return server.stderr instanceof ReadableStream
    ? await Bun.readableStreamToText(server.stderr).catch(() => "")
    : "";
}

/**
 * Wait for the spawned dashboard server to answer `${base}/health`.
 *
 * Unlike a blind poll this watches for the server process exiting early: on a
 * loaded CI runner cold-start can be slow, so we allow generous headroom (60s by
 * default) but fail fast with the captured stderr if the process dies, and drain
 * stderr on timeout so a genuine failure is diagnosable.
 */
export async function waitForHealth(server: Bun.Subprocess, base: string, ms = 60000): Promise<void> {
  let exitCode: number | undefined;
  void server.exited.then((code) => {
    exitCode = code;
  });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (exitCode !== undefined) {
      // Process already exited: stderr is closed, so reading it completes.
      throw new Error(
        `server exited early (code ${exitCode}) before ${base}/health was ready\n${await drainStderr(server)}`
      );
    }
    const res = await fetch(`${base}/health`).catch(() => undefined);
    if (res?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Kill first so the still-open stderr stream closes and can be drained.
  server.kill();
  await server.exited;
  throw new Error(`timed out waiting ${ms}ms for ${base}/health\n${await drainStderr(server)}`);
}
