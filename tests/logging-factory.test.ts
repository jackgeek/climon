import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { logDirForRole, logFilePathForRole } from "../src/logging/sinks.js";

const env = { CLIMON_HOME: "/tmp/climon-test-home" } as NodeJS.ProcessEnv;

describe("log paths", () => {
  test("logDirForRole nests under logs/<role>", () => {
    expect(logDirForRole("server", env)).toBe(join("/tmp/climon-test-home", "logs", "server"));
  });
  test("daemon file path uses session id", () => {
    expect(logFilePathForRole("daemon", env, "abc123")).toBe(
      join("/tmp/climon-test-home", "logs", "daemon", "abc123.log"),
    );
  });
  test("process role file path uses timestamp-pid", () => {
    const p = logFilePathForRole("server", env);
    expect(p.startsWith(join("/tmp/climon-test-home", "logs", "server"))).toBe(true);
    expect(p.endsWith(".log")).toBe(true);
    expect(p).toContain(String(process.pid));
  });
});
