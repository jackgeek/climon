import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NEST_LEVEL_ENV_VAR, SESSION_ENV_VAR } from "../src/config.js";

const home = join(process.cwd(), `.climon-nested-${process.pid}`);

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

describe("nested climon detection", () => {
  test("warns about nesting but still runs the command when inside a session", async () => {
    // Keep the test hermetic: don't auto-link to a real peer climon.
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.jsonc"), '{ "remote": { "autoLink": false } }\n');

    // Simulate being inside an existing climon session: the daemon sets both of
    // these env vars on the command it spawns.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLIMON_HOME: home,
      [SESSION_ENV_VAR]: "parent-session",
      [NEST_LEVEL_ENV_VAR]: "1"
    };

    const proc = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--headless", process.execPath, "--version"],
      {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe"
      }
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);

    // The nested session is allowed: a session id is printed and the command runs.
    const id = stdout.trim();
    expect(id).toMatch(/^[a-z]+(-[a-z]+){2}$/);
    await waitForCompletedSession(id);
    expect(exitCode).toBe(0);

    // It warns about the nesting (depth 2 = one level deeper than the parent).
    expect(stderr).toContain("nested session (depth 2)");
    expect(stderr).not.toContain("cannot start a nested session");
  }, 15000);
});
