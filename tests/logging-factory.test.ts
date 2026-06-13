import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { logDirForRole, logFilePathForRole } from "../src/logging/sinks.js";
import {
  getLogger,
  initLogger,
  resetLoggerForTests,
  suspendTerminal,
  resumeTerminal,
} from "../src/logging/logger.js";

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

describe("logger factory", () => {
  test("silent level creates no logs directory or files", () => {
    const home = mkdtempSync(join(tmpdir(), "climon-silent-"));
    try {
      resetLoggerForTests();
      initLogger("server", { level: "silent", env: { CLIMON_HOME: home } as NodeJS.ProcessEnv });
      const log = getLogger();
      log.info("should not be written");
      log.flush?.();
      expect(existsSync(join(home, "logs"))).toBe(false);
    } finally {
      resetLoggerForTests();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("non-silent level creates the role log directory", () => {
    const home = mkdtempSync(join(tmpdir(), "climon-active-"));
    try {
      resetLoggerForTests();
      initLogger("server", { level: "info", env: { CLIMON_HOME: home } as NodeJS.ProcessEnv });
      getLogger().info("hello");
      expect(existsSync(join(home, "logs", "server"))).toBe(true);
    } finally {
      resetLoggerForTests();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("child logger carries a component binding", () => {
    resetLoggerForTests();
    initLogger("server", { level: "silent" });
    const c = getLogger().child({ component: "push" });
    expect(typeof c.info).toBe("function");
    resetLoggerForTests();
  });

  test("suspendTerminal / resumeTerminal toggle without throwing", () => {
    resetLoggerForTests();
    initLogger("client", { level: "silent" });
    expect(() => { suspendTerminal(); resumeTerminal(); }).not.toThrow();
    resetLoggerForTests();
  });
});
