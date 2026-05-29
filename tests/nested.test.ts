import { afterEach, describe, expect, test } from "bun:test";
import { SESSION_ENV_VAR } from "../src/config.js";
import { startMonitoredCommand } from "../src/launcher.js";

const original = process.env[SESSION_ENV_VAR];

afterEach(() => {
  if (original === undefined) {
    delete process.env[SESSION_ENV_VAR];
  } else {
    process.env[SESSION_ENV_VAR] = original;
  }
});

describe("nested climon detection", () => {
  test("runs the command directly and returns its exit code when inside a session", async () => {
    process.env[SESSION_ENV_VAR] = "test-session";
    const code = await startMonitoredCommand([process.execPath, "-e", "process.exit(0)"]);
    expect(code).toBe(0);
  });

  test("propagates a non-zero exit code from the directly-run command", async () => {
    process.env[SESSION_ENV_VAR] = "test-session";
    const code = await startMonitoredCommand([process.execPath, "-e", "process.exit(3)"]);
    expect(code).toBe(3);
  });
});
