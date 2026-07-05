import { describe, expect, test } from "bun:test";
import { telemetryDefineArgs } from "../scripts/compile.js";

describe("telemetryDefineArgs", () => {
  test("returns no define args when the build env has no connection string", () => {
    expect(telemetryDefineArgs({})).toEqual([]);
  });

  test("ignores an empty or whitespace-only connection string", () => {
    expect(
      telemetryDefineArgs({ APPLICATIONINSIGHTS_CONNECTION_STRING: "   " })
    ).toEqual([]);
  });

  test("emits a bun --define for the embedded telemetry constant when set", () => {
    const conn = "InstrumentationKey=abc;IngestionEndpoint=https://x/";
    expect(
      telemetryDefineArgs({ APPLICATIONINSIGHTS_CONNECTION_STRING: conn })
    ).toEqual(["--define", `__CLIMON_TELEMETRY_CONNECTION__=${JSON.stringify(conn)}`]);
  });

  test("trims surrounding whitespace before embedding", () => {
    expect(
      telemetryDefineArgs({
        APPLICATIONINSIGHTS_CONNECTION_STRING: "  InstrumentationKey=trim  ",
      })
    ).toEqual([
      "--define",
      `__CLIMON_TELEMETRY_CONNECTION__=${JSON.stringify("InstrumentationKey=trim")}`,
    ]);
  });
});
