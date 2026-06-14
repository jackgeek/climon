import { describe, expect, test } from "bun:test";
import { isLogLevel, resolveLevel } from "../src/logging/level.js";

describe("isLogLevel", () => {
  test("accepts pino levels and silent", () => {
    for (const l of ["trace", "debug", "info", "warn", "error", "fatal", "silent"]) {
      expect(isLogLevel(l)).toBe(true);
    }
  });
  test("rejects junk", () => {
    expect(isLogLevel("loud")).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
  });
});

describe("resolveLevel", () => {
  test("env CLIMON_LOG_LEVEL wins over config", () => {
    expect(resolveLevel("warn", { CLIMON_LOG_LEVEL: "debug" })).toBe("debug");
  });
  test("invalid env value is ignored, falls through to config", () => {
    expect(resolveLevel("warn", { CLIMON_LOG_LEVEL: "loud" })).toBe("warn");
  });
  test("config value used when env unset", () => {
    expect(resolveLevel("error", {})).toBe("error");
  });
  test("NODE_ENV=test forces silent when env+config unset", () => {
    expect(resolveLevel(undefined, { NODE_ENV: "test" })).toBe("silent");
  });
  test("explicit env overrides NODE_ENV=test", () => {
    expect(resolveLevel(undefined, { NODE_ENV: "test", CLIMON_LOG_LEVEL: "info" })).toBe("info");
  });
  test("defaults to trace when nothing set", () => {
    expect(resolveLevel(undefined, {})).toBe("trace");
  });
});
