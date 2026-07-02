import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Verifies the dashboard POST /api/sessions routing through the climon client
// without depending on a real client: a stub CLIMON_CLIENT_BIN records its argv
// and returns a fixed JSON outcome. Headless spawns report an id synchronously
// (201); visible spawns return 202 and surface later via the sessions watch.
const created: string[] = [];

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

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await Promise.race([
      Promise.resolve().then(fn).catch(() => undefined),
      new Promise<undefined>((r) => setTimeout(r, 1000, undefined))
    ]);
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function startServer(label: string) {
  const home = join(process.cwd(), ".copilot-tmp", `climon-spawn-route-${process.pid}-${label}`);
  created.push(home);
  const argvFile = join(home, "argv.txt");
  const stub = join(home, "climon-stub.sh");
  const env = { ...process.env, CLIMON_HOME: home, CLIMON_CLIENT_BIN: stub, CLIMON_STUB_ARGV: argvFile };

  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "config.jsonc"),
    JSON.stringify({ version: 1, feature: { sessionSpawning: "enabled" } })
  );
  // Stub climon: record argv, then print an id only for headless spawns.
  await writeFile(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CLIMON_STUB_ARGV"\ncase "$*" in\n  *--headless*) echo '{"id":"stub-1"}' ;;\n  *) echo '{}' ;;\nesac\n`
  );
  await chmod(stub, 0o755);

  const port = await freePort();
  const server = Bun.spawn(
    [process.execPath, "src/server.ts", "server", "--no-takeover", "--port", String(port)],
    { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" }
  );
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    const res = await fetch(`${base}/health`).catch(() => undefined);
    return res?.ok ? true : undefined;
  });
  return { server, base, argvFile, home };
}

describe("POST /api/sessions headless vs visible routing", () => {
  test("headless: true returns 201 with the client id and passes --headless", async () => {
    const { server, base, argvFile, home } = await startServer("headless");
    try {
      const res = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "bash", cwd: home, headless: true })
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { id?: string }).id).toBe("stub-1");
      const argv = await readFile(argvFile, "utf8");
      expect(argv).toContain("__spawn");
      expect(argv).toContain("--headless");
    } finally {
      server.kill();
      await server.exited;
    }
  }, 60000);

  test("default (visible) returns 202 and omits --headless", async () => {
    const { server, base, argvFile, home } = await startServer("visible");
    try {
      const res = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "bash", cwd: home })
      });
      expect(res.status).toBe(202);
      const argv = await readFile(argvFile, "utf8");
      expect(argv).toContain("__spawn");
      expect(argv).not.toContain("--headless");
    } finally {
      server.kill();
      await server.exited;
    }
  }, 60000);
});
