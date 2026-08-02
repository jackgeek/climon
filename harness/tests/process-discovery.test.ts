import { describe, expect, test } from "bun:test";
import {
  commandContainsSessionToken,
  parsePositivePid,
  parseUnixPsOutput,
  parseWindowsPsOutput,
  resolveSessionHost,
} from "../src/drivers/process-discovery.js";
import type { CommandRunner, CommandResult } from "../src/command.js";

// ── commandContainsSessionToken ───────────────────────────────────────────────

describe("commandContainsSessionToken", () => {
  test("matches exact consecutive token pair __session <id>", () => {
    expect(
      commandContainsSessionToken(["climon", "__session", "abc123"], "abc123")
    ).toBe(true);
  });

  test("matches at beginning of token list", () => {
    expect(
      commandContainsSessionToken(["__session", "abc123", "extra"], "abc123")
    ).toBe(true);
  });

  test("rejects substring: abc123 does NOT match token abc123def", () => {
    expect(
      commandContainsSessionToken(["climon", "__session", "abc123def"], "abc123")
    ).toBe(false);
  });

  test("rejects when __session is last token (no following token)", () => {
    expect(
      commandContainsSessionToken(["climon", "__session"], "abc123")
    ).toBe(false);
  });

  test("rejects when session id token exists but not preceded by __session", () => {
    expect(
      commandContainsSessionToken(["climon", "run", "abc123"], "abc123")
    ).toBe(false);
  });

  test("rejects on empty tokens", () => {
    expect(commandContainsSessionToken([], "abc123")).toBe(false);
  });

  test("rejects single token", () => {
    expect(commandContainsSessionToken(["abc123"], "abc123")).toBe(false);
  });

  test("rejects when __session precedes a different id", () => {
    expect(
      commandContainsSessionToken(["climon", "__session", "other-id"], "abc123")
    ).toBe(false);
  });

  test("matches with dots and tildes and hyphens in session id", () => {
    const sessionId = "session~1.2-test";
    expect(
      commandContainsSessionToken(
        ["/usr/bin/climon", "__session", sessionId],
        sessionId
      )
    ).toBe(true);
  });
});

// ── parsePositivePid ──────────────────────────────────────────────────────────

describe("parsePositivePid", () => {
  test("parses a valid PID", () => {
    expect(parsePositivePid("1234")).toBe(1234);
  });

  test("parses a PID with leading/trailing spaces", () => {
    expect(parsePositivePid("  5678  ")).toBe(5678);
  });

  test("returns undefined for zero", () => {
    expect(parsePositivePid("0")).toBeUndefined();
  });

  test("returns undefined for negative", () => {
    expect(parsePositivePid("-1")).toBeUndefined();
  });

  test("returns undefined for non-numeric", () => {
    expect(parsePositivePid("abc")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(parsePositivePid("")).toBeUndefined();
  });

  test("returns undefined for float string", () => {
    expect(parsePositivePid("1.5")).toBeUndefined();
  });
});

// ── parseUnixPsOutput ─────────────────────────────────────────────────────────

describe("parseUnixPsOutput", () => {
  test("happy path: single matching line", () => {
    const stdout = [
      "  100 /usr/bin/climon __session abc123",
      " 9999 bash",
      "  101 /usr/local/bin/node ./server.js",
    ].join("\n");

    const result = parseUnixPsOutput(stdout, "abc123");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.pid).toBe(100);
    expect(result.candidates[0]!.command).toContain("__session abc123");
    expect(result.childGuardedPids).toHaveLength(0);
  });

  test("substring trap: abc123 does not match abc123def line", () => {
    const stdout = [
      "  100 /usr/bin/climon __session abc123def",
      "  200 /usr/bin/climon __session abc12",
    ].join("\n");

    const result = parseUnixPsOutput(stdout, "abc123");
    expect(result.candidates).toHaveLength(0);
  });

  test("multiple matching candidates are all returned", () => {
    const stdout = [
      "  100 climon __session abc123",
      "  200 climon __session abc123",
    ].join("\n");

    const result = parseUnixPsOutput(stdout, "abc123");
    expect(result.candidates).toHaveLength(2);
  });

  test("child PID guard: candidate with daemonChildPid is filtered out", () => {
    const stdout = [
      "  100 climon __session abc123",
    ].join("\n");

    const result = parseUnixPsOutput(stdout, "abc123", 100);
    expect(result.candidates).toHaveLength(0);
    expect(result.childGuardedPids).toEqual([100]);
    expect(result.diagnostics.some((d) => d.includes("child-guard"))).toBe(true);
  });

  test("child PID guard does not filter non-matching PIDs", () => {
    const stdout = [
      "  100 climon __session abc123",
    ].join("\n");

    const result = parseUnixPsOutput(stdout, "abc123", 999);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.pid).toBe(100);
    expect(result.childGuardedPids).toHaveLength(0);
  });

  test("skips blank lines and single-token lines", () => {
    const stdout = "\n\n  \n  100 climon __session abc123\n  \n";
    const result = parseUnixPsOutput(stdout, "abc123");
    expect(result.candidates).toHaveLength(1);
  });

  test("handles lines with only PID (single token) as malformed", () => {
    const stdout = "  1234\n  100 climon __session abc123";
    const result = parseUnixPsOutput(stdout, "abc123");
    expect(result.malformedLines).toBeGreaterThan(0);
    expect(result.candidates).toHaveLength(1);
  });

  test("preserves full command string including arguments after session id", () => {
    const stdout = "  100 /usr/bin/climon __session abc123 --extra-arg";
    const result = parseUnixPsOutput(stdout, "abc123");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.command).toBe("/usr/bin/climon __session abc123 --extra-arg");
  });

  test("handles PID with leading spaces from ps output", () => {
    const stdout = "   42 climon __session my-sess";
    const result = parseUnixPsOutput(stdout, "my-sess");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.pid).toBe(42);
  });

  test("empty stdout returns empty candidates", () => {
    const result = parseUnixPsOutput("", "abc123");
    expect(result.candidates).toHaveLength(0);
  });

  test("no matching lines returns empty candidates", () => {
    const stdout = [
      " 100 bash",
      " 200 node server.js",
    ].join("\n");
    const result = parseUnixPsOutput(stdout, "abc123");
    expect(result.candidates).toHaveLength(0);
  });
});

// ── parseWindowsPsOutput ──────────────────────────────────────────────────────

describe("parseWindowsPsOutput", () => {
  test("happy path: single JSON object", () => {
    const stdout = JSON.stringify({
      ProcessId: 1234,
      CommandLine: "climon.exe __session win-sess-01",
    });

    const result = parseWindowsPsOutput(stdout, "win-sess-01");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.pid).toBe(1234);
    expect(result.candidates[0]!.command).toContain("__session win-sess-01");
  });

  test("JSON array with multiple entries: returns multiple candidates", () => {
    const stdout = JSON.stringify([
      { ProcessId: 1234, CommandLine: "climon.exe __session win-sess-01" },
      { ProcessId: 5678, CommandLine: "climon.exe __session win-sess-01" },
    ]);

    const result = parseWindowsPsOutput(stdout, "win-sess-01");
    expect(result.candidates).toHaveLength(2);
  });

  test("JSON array with no matching entries", () => {
    const stdout = JSON.stringify([
      { ProcessId: 1234, CommandLine: "climon.exe __session other-sess" },
    ]);

    const result = parseWindowsPsOutput(stdout, "win-sess-01");
    expect(result.candidates).toHaveLength(0);
  });

  test("empty stdout returns empty candidates", () => {
    const result = parseWindowsPsOutput("", "win-sess-01");
    expect(result.candidates).toHaveLength(0);
  });

  test("null output returns empty candidates", () => {
    const result = parseWindowsPsOutput("null", "win-sess-01");
    expect(result.candidates).toHaveLength(0);
  });

  test("malformed JSON returns empty candidates with parse error diagnostic", () => {
    const result = parseWindowsPsOutput("not-valid-json}", "win-sess-01");
    expect(result.candidates).toHaveLength(0);
    expect(result.malformedLines).toBe(1);
    expect(result.diagnostics.some((d) => d.startsWith("json-parse-error"))).toBe(true);
  });

  test("substring trap: exact boundary required in CommandLine", () => {
    const stdout = JSON.stringify({
      ProcessId: 9999,
      CommandLine: "climon.exe __session win-sess-01-longer",
    });
    const result = parseWindowsPsOutput(stdout, "win-sess-01");
    expect(result.candidates).toHaveLength(0);
  });

  test("child PID guard filters matching PID", () => {
    const stdout = JSON.stringify({
      ProcessId: 1234,
      CommandLine: "climon.exe __session win-sess-01",
    });
    const result = parseWindowsPsOutput(stdout, "win-sess-01", 1234);
    expect(result.candidates).toHaveLength(0);
    expect(result.childGuardedPids).toEqual([1234]);
  });

  test("invalid ProcessId (non-integer) is malformed", () => {
    const stdout = JSON.stringify({
      ProcessId: "not-a-number",
      CommandLine: "climon.exe __session win-sess-01",
    });
    const result = parseWindowsPsOutput(stdout, "win-sess-01");
    expect(result.candidates).toHaveLength(0);
    expect(result.malformedLines).toBeGreaterThan(0);
  });

  test("null CommandLine is malformed", () => {
    const stdout = JSON.stringify({
      ProcessId: 1234,
      CommandLine: null,
    });
    const result = parseWindowsPsOutput(stdout, "win-sess-01");
    expect(result.candidates).toHaveLength(0);
    expect(result.malformedLines).toBeGreaterThan(0);
  });

  test("empty JSON array returns empty candidates", () => {
    const result = parseWindowsPsOutput("[]", "win-sess-01");
    expect(result.candidates).toHaveLength(0);
  });
});

// ── resolveSessionHost ────────────────────────────────────────────────────────

describe("resolveSessionHost: validation", () => {
  function makeFakeRunner(stdout: string, exitCode = 0): CommandRunner {
    return {
      async run(): Promise<CommandResult> {
        return { code: exitCode, stdout, stderr: "", durationMs: 5 };
      },
    };
  }

  test("throws HarnessError prerequisite for invalid session id (has space)", async () => {
    const runner = makeFakeRunner("  100 climon __session bad id\n");
    await expect(
      resolveSessionHost("linux", "bad id", runner, {
        artifactsDir: "/fake/artifacts",
      })
    ).rejects.toMatchObject({ kind: "prerequisite" });
  });

  test("throws HarnessError prerequisite for empty session id", async () => {
    const runner = makeFakeRunner("");
    await expect(
      resolveSessionHost("linux", "", runner, { artifactsDir: "/fake/artifacts" })
    ).rejects.toMatchObject({ kind: "prerequisite" });
  });

  test("Unix: throws assertion when no matching process found", async () => {
    const runner = makeFakeRunner("  100 bash\n  200 node\n");
    await expect(
      resolveSessionHost("linux", "abc123", runner, {
        artifactsDir: "/fake/artifacts",
      })
    ).rejects.toMatchObject({ kind: "assertion" });
  });

  test("Unix: returns single host when exactly one match", async () => {
    const runner = makeFakeRunner("  1234 climon __session abc123\n  5678 bash\n");
    const host = await resolveSessionHost("linux", "abc123", runner, {
      artifactsDir: "/fake/artifacts",
    });
    expect(host.pid).toBe(1234);
    expect(host.command).toContain("__session abc123");
  });

  test("Unix: throws assertion when multiple processes match (ambiguous)", async () => {
    const runner = makeFakeRunner(
      "  1234 climon __session abc123\n  5678 climon __session abc123\n"
    );
    await expect(
      resolveSessionHost("linux", "abc123", runner, {
        artifactsDir: "/fake/artifacts",
      })
    ).rejects.toMatchObject({ kind: "assertion" });
  });

  test("macOS platform uses same Unix path", async () => {
    let usedFile = "";
    const runner: CommandRunner = {
      async run(spec) {
        usedFile = spec.file;
        return {
          code: 0,
          stdout: "  42 climon __session my-sess\n",
          stderr: "",
          durationMs: 5,
        };
      },
    };
    const host = await resolveSessionHost("macos", "my-sess", runner, {
      artifactsDir: "/fake/artifacts",
    });
    expect(host.pid).toBe(42);
    expect(usedFile).toBe("ps");
  });

  test("Windows: uses powershell.exe executable", async () => {
    let capturedSpec: { file: string; args: string[] } | undefined;
    const runner: CommandRunner = {
      async run(spec) {
        capturedSpec = { file: spec.file, args: spec.args };
        return {
          code: 0,
          stdout: JSON.stringify({ ProcessId: 1234, CommandLine: "climon __session win-sess" }),
          stderr: "",
          durationMs: 5,
        };
      },
    };
    await resolveSessionHost("windows", "win-sess", runner, {
      artifactsDir: "/fake/artifacts",
    });
    expect(capturedSpec?.file).toBe("powershell.exe");
    expect(capturedSpec?.args).toContain("-NonInteractive");
    expect(capturedSpec?.args).toContain("-NoProfile");
  });

  test("Windows: throws assertion when no process found", async () => {
    const runner = makeFakeRunner("null");
    await expect(
      resolveSessionHost("windows", "win-sess", runner, {
        artifactsDir: "/fake/artifacts",
      })
    ).rejects.toMatchObject({ kind: "assertion" });
  });

  test("Unix: ps command failure (non-zero exit) throws prerequisite", async () => {
    const runner: CommandRunner = {
      async run() {
        return { code: 1, stdout: "", stderr: "permission denied", durationMs: 5 };
      },
    };
    await expect(
      resolveSessionHost("linux", "abc123", runner, {
        artifactsDir: "/fake/artifacts",
      })
    ).rejects.toMatchObject({ kind: "prerequisite" });
  });

  test("Unix: ps args are exactly [-axo, pid=,command=] with shell=false", async () => {
    let capturedSpec: { file: string; args: string[] } | undefined;
    const runner: CommandRunner = {
      async run(spec) {
        capturedSpec = { file: spec.file, args: [...spec.args] };
        return {
          code: 0,
          stdout: "  99 climon __session known-session\n",
          stderr: "",
          durationMs: 5,
        };
      },
    };
    await resolveSessionHost("linux", "known-session", runner, {
      artifactsDir: "/fake/artifacts",
    });
    expect(capturedSpec?.file).toBe("ps");
    expect(capturedSpec?.args).toEqual(["-axo", "pid=,command="]);
  });
});
