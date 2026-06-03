import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SESSION_ENV_VAR } from "../src/config.js";
import { startMonitoredCommand } from "../src/launcher.js";

const original = process.env[SESSION_ENV_VAR];
const tempDirs: string[] = [];

afterEach(() => {
  if (original === undefined) {
    delete process.env[SESSION_ENV_VAR];
  } else {
    process.env[SESSION_ENV_VAR] = original;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("nested climon detection", () => {
  test("returns an error without running the command when inside a session", async () => {
    process.env[SESSION_ENV_VAR] = "test-session";
    const tempDir = mkdtempSync(join(process.cwd(), ".nested-test-"));
    tempDirs.push(tempDir);
    const marker = join(tempDir, "nested-command-ran");
    const originalWrite = process.stderr.write.bind(process.stderr);
    let stderr = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write;

    try {
      const code = await startMonitoredCommand([
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`
      ]);
      expect(code).toBe(1);
    } finally {
      process.stderr.write = originalWrite as typeof process.stderr.write;
    }

    expect(stderr).toContain("climon: cannot start a nested session");
    expect(existsSync(marker)).toBe(false);
  });
});
