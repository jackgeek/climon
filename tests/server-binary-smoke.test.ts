import { describe, expect, test } from "bun:test";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compiledServerBuildArgs } from "../scripts/server-build.js";

// Opt-in only: this test runs the real, slow `bun build --compile` of
// src/server.ts for the native target and boots the resulting binary. CI runs
// it on the 3-OS matrix via CLIMON_RUN_SERVER_SMOKE=1; the default
// `bun test tests` skips it so the suite stays fast.
const RUN = process.env.CLIMON_RUN_SERVER_SMOKE === "1";

/** Reserves an ephemeral TCP port, then releases it for the server to bind. */
function freePort(): Promise<number> {
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

describe.skipIf(!RUN)("compiled climon-server binary", () => {
  test(
    "compiles src/server.ts and serves the dashboard health endpoint",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "climon-server-smoke-"));
      const home = mkdtempSync(join(tmpdir(), "climon-server-smoke-home-"));
      const exe = process.platform === "win32" ? ".exe" : "";
      const out = join(dir, `climon-server${exe}`);

      try {
        // Embed assets so the compiled server can serve the dashboard bundle,
        // then compile the standalone server binary for the native target.
        expect(
          spawnSync("bun", ["scripts/embed-assets.ts"], { stdio: "inherit" }).status
        ).toBe(0);
        expect(
          spawnSync("bun", compiledServerBuildArgs(out), { stdio: "inherit" }).status
        ).toBe(0);
        expect(existsSync(out)).toBe(true);

        // Boot it on a free port in an isolated CLIMON_HOME. The server logs
        // (not stdout) its listening line, so prove startup by polling the
        // dashboard /health endpoint instead — the same signal the other
        // server integration tests use.
        const port = await freePort();
        const child = spawn(out, ["server", "--no-takeover", "--port", String(port)], {
          env: { ...process.env, CLIMON_HOME: home },
          stdio: ["ignore", "pipe", "pipe"],
        });

        try {
          const base = `http://127.0.0.1:${port}`;
          const deadline = Date.now() + 30_000;
          let healthy = false;
          while (Date.now() < deadline) {
            if (child.exitCode !== null) break; // the binary died during startup
            const res = await fetch(`${base}/health`).catch(() => undefined);
            if (res?.ok) {
              healthy = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 200));
          }
          expect(healthy).toBe(true);

          // Regression guard: the compiled binary must serve the embedded
          // dashboard assets. A binary built without the embedded-asset define
          // falls back to an on-the-fly source build, which fails on a machine
          // that only has the shipped binary (e.g. a fresh Windows install),
          // so these requests 404. Assert the assets reached by the dashboard
          // HTML + manifest (app.js, xterm.css, an icon) all serve real bytes.
          for (const path of ["/assets/app.js", "/assets/xterm.css", "/assets/icon-192.png"]) {
            const res = await fetch(`${base}${path}`);
            expect(res.status).toBe(200);
            const body = await res.arrayBuffer();
            expect(body.byteLength).toBeGreaterThan(0);
          }
        } finally {
          child.kill();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
    120_000
  );
});
