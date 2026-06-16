import { describe, expect, test } from "bun:test";
import { parseSetupOptions } from "../src/setup/onboarding.js";

describe("parseSetupOptions", () => {
  test("defaults: interactive, no flags set", () => {
    const o = parseSetupOptions([]);
    expect(o.apply).toBe(false);
    expect(o.acceptEula).toBe(false);
    expect(o.telemetry).toBeUndefined();
    expect(o.autoUpdate).toBeUndefined();
  });

  test("parses --apply --accept-eula --telemetry=on --auto-update=off", () => {
    const o = parseSetupOptions([
      "--apply",
      "--accept-eula",
      "--telemetry=on",
      "--auto-update=off",
    ]);
    expect(o.apply).toBe(true);
    expect(o.acceptEula).toBe(true);
    expect(o.telemetry).toBe(true);
    expect(o.autoUpdate).toBe(false);
  });

  test("telemetry=off parses to false, unknown value throws", () => {
    expect(parseSetupOptions(["--telemetry=off"]).telemetry).toBe(false);
    expect(() => parseSetupOptions(["--telemetry=maybe"])).toThrow();
  });
});
