import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NEST_LEVEL_ENV_VAR, SESSION_ENV_VAR } from "../src/config.js";

const home = join(process.cwd(), `.climon-headless-fast-exit-${process.pid}`);
const env: NodeJS.ProcessEnv = { ...process.env, CLIMON_HOME: home };
delete env[SESSION_ENV_VAR];
delete env[NEST_LEVEL_ENV_VAR];

async function waitForCompletedSession(id: string): Promise<void> {
  const metaPath = join(home, "sessions", `${id}.json`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as { status?: string };
      if (meta.status === "completed") {
        return;
      }
    } catch {
      // The daemon may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for session ${id} to complete`);
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("headless run", () => {
  test("prints a session id for fast-exiting commands", async () => {
    // Keep the test hermetic: don't auto-link to a real peer climon (auto-link
    // prints status messages to stderr, which this test asserts is empty).
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.jsonc"), '{ "remote": { "autoLink": false } }\n');

    const proc = Bun.spawn([process.execPath, "src/index.ts", "run", "--headless", process.execPath, "--version"], {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe"
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);

    const id = stdout.trim();
    await waitForCompletedSession(id);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(id).toMatch(/^[a-z]+(-[a-z]+){2}$/);
  }, 15000);
});
