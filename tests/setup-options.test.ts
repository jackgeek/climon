import { describe, expect, test } from "bun:test";
import { parseSetupOptions } from "../src/setup/onboarding.js";

describe("parseSetupOptions", () => {
  test("defaults: interactive, no flags set", () => {
    const o = parseSetupOptions([]);
    expect(o).toEqual({ apply: false });
  });

  test("parses --apply --telemetry=on --auto-update=off", () => {
    const o = parseSetupOptions([
      "--apply",
      "--telemetry=on",
      "--auto-update=off",
    ]);
    expect(o).toEqual({ apply: true, telemetry: true, autoUpdate: false });
  });

  test("telemetry=off parses to false, unknown value throws", () => {
    expect(parseSetupOptions(["--telemetry=off"]).telemetry).toBe(false);
    expect(() => parseSetupOptions(["--telemetry=maybe"])).toThrow();
  });
});
