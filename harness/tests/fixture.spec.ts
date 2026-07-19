import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

const fixtureScript = resolve(
  import.meta.dirname,
  "../fixtures/echo-session.mjs"
);

test("echo-session fixture: PING/ECHO/EXIT protocol", async () => {
  const child = spawn(process.execPath, [fixtureScript], {
    stdio: "pipe",
  });

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });

  try {
    // Wait until CIH_READY is visible in stdout
    await expect
      .poll(() => output, { timeout: 10_000 })
      .toContain("CIH_READY");

    // Send PING
    child.stdin.write("PING token-123\n");

    // Wait for CIH_ECHO
    await expect
      .poll(() => output, { timeout: 10_000 })
      .toContain("CIH_ECHO token-123");

    // Send EXIT 0
    child.stdin.write("EXIT 0\n");

    // Await child exit
    const [code] = await once(child, "close");

    expect(code).toBe(0);
    expect(output).toContain("CIH_EXIT 0");
  } finally {
    if (!child.killed) {
      child.kill();
    }
  }
});
