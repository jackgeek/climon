import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { initLogger, resetLoggerForTests, getLogger } from "../src/logging/logger.js";
import { writeStdout, writeStderr, logCliCommand, CLIMON_SUBCOMMANDS } from "../src/logging/cli-io.js";

function withCapturedStdio(fn: () => void): { out: string; err: string } {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { out, err };
}

function readLogs(home: string): string {
  const dir = join(home, "logs", "client");
  return readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("");
}

describe("cli-io tee", () => {
  test("writeStdout prints to stdout and mirrors to the cli debug log", () => {
    const home = mkdtempSync(join(tmpdir(), "climon-cliio-"));
    try {
      resetLoggerForTests();
      initLogger("client", { level: "debug", env: { CLIMON_HOME: home } as NodeJS.ProcessEnv });
      const { out } = withCapturedStdio(() => writeStdout("Killed session abc.\n"));
      getLogger().flush?.();
      expect(out).toBe("Killed session abc.\n");
      const logs = readLogs(home);
      expect(logs).toContain("Killed session abc.");
      expect(logs).toContain("\"component\":\"cli\"");
      expect(logs).toContain("\"stream\":\"stdout\"");
      expect(logs).toContain("\"level\":20");
    } finally {
      resetLoggerForTests();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("writeStderr mirrors to debug log and strips ANSI color codes", () => {
    const home = mkdtempSync(join(tmpdir(), "climon-cliio-"));
    try {
      resetLoggerForTests();
      initLogger("client", { level: "debug", env: { CLIMON_HOME: home } as NodeJS.ProcessEnv });
      const { err } = withCapturedStdio(() => writeStderr("\x1b[33mclimon: nested session\x1b[0m\n"));
      getLogger().flush?.();
      expect(err).toContain("\x1b[33m");
      const logs = readLogs(home);
      expect(logs).toContain("climon: nested session");
      expect(logs).not.toContain("\\u001b");
      expect(logs).toContain("\"stream\":\"stderr\"");
    } finally {
      resetLoggerForTests();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("logCliCommand records the subcommand at debug", () => {
    const home = mkdtempSync(join(tmpdir(), "climon-cliio-"));
    try {
      resetLoggerForTests();
      initLogger("client", { level: "debug", env: { CLIMON_HOME: home } as NodeJS.ProcessEnv });
      logCliCommand("cleanup");
      getLogger().flush?.();
      const logs = readLogs(home);
      expect(logs).toContain("cli command: cleanup");
      expect(logs).toContain("\"subcommand\":\"cleanup\"");
      expect(logs).not.toContain("\"command\":\"cleanup\"");
    } finally {
      resetLoggerForTests();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("logCliCommand only accepts allowlisted subcommand names", () => {
    const home = mkdtempSync(join(tmpdir(), "climon-cliio-"));
    try {
      resetLoggerForTests();
      initLogger("client", { level: "debug", env: { CLIMON_HOME: home } as NodeJS.ProcessEnv });
      for (const name of CLIMON_SUBCOMMANDS) {
        logCliCommand(name);
      }
      getLogger().flush?.();
      const logs = readLogs(home);
      for (const name of CLIMON_SUBCOMMANDS) {
        expect(logs).toContain(`"subcommand":"${name}"`);
      }
    } finally {
      resetLoggerForTests();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
