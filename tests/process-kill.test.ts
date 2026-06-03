import { describe, expect, test } from "bun:test";
import { killProcess, type KillRunner } from "../src/process-kill.js";

function recorder(): { calls: Array<[string, string[]]>; run: KillRunner } {
  const calls: Array<[string, string[]]> = [];
  const run: KillRunner = (cmd, args) => {
    calls.push([cmd, args]);
    return { status: 0 };
  };
  return { calls, run };
}

describe("killProcess on win32", () => {
  test("graceful uses taskkill /T without /F", () => {
    const { calls, run } = recorder();
    expect(killProcess(1234, false, "win32", run)).toBe(true);
    expect(calls).toEqual([["taskkill", ["/PID", "1234", "/T"]]]);
  });

  test("force uses taskkill /T /F", () => {
    const { calls, run } = recorder();
    expect(killProcess(1234, true, "win32", run)).toBe(true);
    expect(calls).toEqual([["taskkill", ["/PID", "1234", "/T", "/F"]]]);
  });

  test("returns false when taskkill exits non-zero", () => {
    const run: KillRunner = () => ({ status: 1 });
    expect(killProcess(1234, true, "win32", run)).toBe(false);
  });
});

describe("killProcess on posix", () => {
  test("does not invoke taskkill", () => {
    const { calls, run } = recorder();
    killProcess(2147483646, false, "linux", run);
    expect(calls).toEqual([]);
  });
});
