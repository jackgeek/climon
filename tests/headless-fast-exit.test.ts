import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const home = join(process.cwd(), `.climon-headless-fast-exit-${process.pid}`);

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
    const proc = Bun.spawn([process.execPath, "src/index.ts", "run", "--headless", "echo", "headless-fast-exit"], {
      cwd: process.cwd(),
      env: { ...process.env, CLIMON_HOME: home },
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
    expect(id).toMatch(/^[a-z0-9]+-[a-f0-9]{6}$/);
  }, 15000);
});
