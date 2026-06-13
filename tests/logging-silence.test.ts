import { describe, expect, test } from "bun:test";

describe("test silencing", () => {
  test("CLIMON_LOG_LEVEL is silent during tests", () => {
    expect(process.env.CLIMON_LOG_LEVEL).toBe("silent");
  });
});
