import { expect, test } from "@playwright/test";
import { HarnessError } from "../src/types.js";
import {
  executableName,
  platformFromNode,
  processTreeTermination,
} from "../src/platform.js";

// platformFromNode

test("platformFromNode: darwin maps to macos", () => {
  expect(platformFromNode("darwin")).toBe("macos");
});

test("platformFromNode: linux maps to linux", () => {
  expect(platformFromNode("linux")).toBe("linux");
});

test("platformFromNode: win32 maps to windows", () => {
  expect(platformFromNode("win32")).toBe("windows");
});

test("platformFromNode: unsupported platform throws with 'unsupported platform'", () => {
  expect(() => platformFromNode("aix")).toThrow("unsupported platform");
});

test("platformFromNode: unsupported platform throws HarnessError", () => {
  const err = (() => {
    try {
      platformFromNode("aix");
    } catch (e) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(HarnessError);
});

// executableName

test("executableName: appends .exe on windows", () => {
  expect(executableName("climon", "windows")).toBe("climon.exe");
});

test("executableName: no suffix on linux", () => {
  expect(executableName("climon", "linux")).toBe("climon");
});

test("executableName: no suffix on macos", () => {
  expect(executableName("climon", "macos")).toBe("climon");
});

test("executableName: does not double-append .exe if already ends with .exe", () => {
  expect(executableName("climon.exe", "windows")).toBe("climon.exe");
});

// processTreeTermination

test("processTreeTermination: windows with force=true returns taskkill with /F", () => {
  const result = processTreeTermination("windows", 1234, true);
  expect(result).toEqual({ file: "taskkill", args: ["/PID", "1234", "/T", "/F"] });
});

test("processTreeTermination: windows with force=false omits /F", () => {
  const result = processTreeTermination("windows", 1234, false);
  expect(result).toEqual({ file: "taskkill", args: ["/PID", "1234", "/T"] });
});

test("processTreeTermination: linux with force=false returns SIGTERM at negative pid", () => {
  const result = processTreeTermination("linux", 1234, false);
  expect(result).toEqual({ signal: "SIGTERM", pid: -1234 });
});

test("processTreeTermination: linux with force=true returns SIGKILL at negative pid", () => {
  const result = processTreeTermination("linux", 1234, true);
  expect(result).toEqual({ signal: "SIGKILL", pid: -1234 });
});

test("processTreeTermination: macos with force=false returns SIGTERM at negative pid", () => {
  const result = processTreeTermination("macos", 1234, false);
  expect(result).toEqual({ signal: "SIGTERM", pid: -1234 });
});
