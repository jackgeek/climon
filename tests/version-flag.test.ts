import { describe, expect, test } from "bun:test";
import { VERSION } from "../src/version.js";

describe("climon --version", () => {
  test("prints the climon version and exits successfully", async () => {
    const proc = Bun.spawn([process.execPath, "src/index.ts", "--version"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe"
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe(`climon v${VERSION}\n`);
  });
});
