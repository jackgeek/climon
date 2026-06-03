import { describe, expect, test } from "bun:test";
import { statusBadgeColor } from "../src/web/components/StatusBadge.js";

describe("statusBadgeColor", () => {
  test("uses a blue brand pill for running sessions", () => {
    expect(statusBadgeColor("running")).toBe("brand");
  });
});
