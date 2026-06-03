import { describe, expect, test } from "bun:test";
import type { SessionStatus } from "../src/types.js";
import { STATUS_INITIALS, STATUS_LABELS } from "../src/web/components/StatusBadge.js";

const statuses: SessionStatus[] = ["running", "needs-attention", "completed", "failed", "disconnected"];

describe("StatusBadge label maps", () => {
  test("defines compact initials for every session status", () => {
    expect(STATUS_INITIALS).toEqual({
      running: "R",
      "needs-attention": "NA",
      completed: "C",
      failed: "F",
      disconnected: "D"
    });

    for (const status of statuses) {
      expect(STATUS_INITIALS[status].length).toBeGreaterThan(0);
    }
  });

  test("keeps full labels for every session status", () => {
    expect(STATUS_LABELS).toEqual({
      running: "running",
      "needs-attention": "needs attention",
      completed: "completed",
      failed: "failed",
      disconnected: "disconnected"
    });

    for (const status of statuses) {
      expect(STATUS_LABELS[status].length).toBeGreaterThan(0);
    }
  });
});
