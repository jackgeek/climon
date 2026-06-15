import { describe, expect, test } from "bun:test";
import { createAppInsightsStream } from "../src/logging/appinsights.js";

describe("createAppInsightsStream", () => {
  test("returns undefined for an empty connection regardless of installId", async () => {
    expect(await createAppInsightsStream("", { installId: "abc" })).toBeUndefined();
  });
});
