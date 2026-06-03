import { describe, expect, test } from "bun:test";
import { DASHBOARD_HEADER_HEIGHT, SESSION_COLOR_ACCENT_WIDTH } from "../src/web/layout.js";

describe("dashboard layout constants", () => {
  test("uses a shared header height for the sidebar and main window", () => {
    expect(DASHBOARD_HEADER_HEIGHT).toBe("55px");
  });

  test("uses a shared color accent width for session list and terminal accents", () => {
    expect(SESSION_COLOR_ACCENT_WIDTH).toBe("4px");
  });
});
