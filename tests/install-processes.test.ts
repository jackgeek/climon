import { describe, expect, test } from "bun:test";
import { killRunningClimonProcessesScript } from "../src/install/processes.js";

describe("killRunningClimonProcessesScript", () => {
  test("stops climon processes if they are running", () => {
    expect(killRunningClimonProcessesScript).toContain("Get-Process -Name 'climon'");
    expect(killRunningClimonProcessesScript).toContain("Stop-Process -Force");
    expect(killRunningClimonProcessesScript).toContain("-ErrorAction SilentlyContinue");
  });
});
