import { describe, expect, test } from "bun:test";
import { DASHBOARD_HEADER_HEIGHT } from "../src/web/layout.js";

describe("dashboard layout constants", () => {
  test("uses a shared header height for the sidebar and main window", () => {
    expect(DASHBOARD_HEADER_HEIGHT).toBe("55px");
  });
});
