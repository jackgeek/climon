import { describe, test, expect } from "bun:test";
import { detectParentShell, buildShellArgv } from "../src/detect-shell.js";

describe("detectParentShell", () => {
  test("returns a non-empty string", () => {
    const shell = detectParentShell();
    expect(shell).toBeTruthy();
    expect(typeof shell).toBe("string");
    expect(shell.length).toBeGreaterThan(0);
  });

  test("returns a plausible shell executable", () => {
    const shell = detectParentShell();
    // On any platform, the result should contain a recognizable shell name
    const lower = shell.toLowerCase();
    const knownShells = ["bash", "zsh", "fish", "sh", "powershell", "pwsh", "cmd", "nu", "elvish"];
    const looksLikeShell = knownShells.some(s => lower.includes(s));
    // If running under bun test, parent might be bun — which gets blocklisted
    // and falls back to $SHELL or $ComSpec, so this should still pass
    if (!looksLikeShell) {
      // Fallback: at minimum it should be a path-like string or known fallback
      expect(lower).toMatch(/\.(exe|sh)$|\/bin\/|\\system32\\/i);
    }
  });
});

describe("buildShellArgv", () => {
  test("returns shell as single-element array", () => {
    expect(buildShellArgv("C:\\Program Files\\PowerShell\\7\\pwsh.exe"))
      .toEqual(["C:\\Program Files\\PowerShell\\7\\pwsh.exe"]);
  });

  test("no extra args for bash", () => {
    expect(buildShellArgv("/bin/bash")).toEqual(["/bin/bash"]);
  });

  test("no extra args for cmd", () => {
    expect(buildShellArgv("C:\\Windows\\System32\\cmd.exe")).toEqual(["C:\\Windows\\System32\\cmd.exe"]);
  });
});
