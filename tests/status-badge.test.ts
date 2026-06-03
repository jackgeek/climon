import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionStatus } from "../src/types.js";
import { StatusBadge, STATUS_INITIALS, STATUS_LABELS, statusBadgeColor } from "../src/web/components/StatusBadge.js";

const statuses: SessionStatus[] = ["running", "available", "needs-attention", "completed", "failed", "disconnected"];

describe("StatusBadge label maps", () => {
  test("defines compact initials for every session status", () => {
    expect(STATUS_INITIALS).toEqual({
      running: "R",
      available: "A",
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
      available: "available",
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

describe("statusBadgeColor", () => {
  test("uses a blue brand pill for running sessions", () => {
    expect(statusBadgeColor("running")).toBe("brand");
  });
});

describe("StatusBadge rendering", () => {
  test("renders the full label by default", () => {
    const markup = renderToStaticMarkup(createElement(StatusBadge, { status: "needs-attention" }));

    expect(markup).toContain(">needs attention<");
  });

  test("renders compact initials when compact is true", () => {
    const markup = renderToStaticMarkup(createElement(StatusBadge, { compact: true, status: "needs-attention" }));

    expect(markup).toContain(">NA<");
    expect(markup).not.toContain(">needs attention<");
  });

  test("sets the title to the full label", () => {
    const markup = renderToStaticMarkup(createElement(StatusBadge, { compact: true, status: "needs-attention" }));

    expect(markup).toContain('title="needs attention"');
  });

  test("can omit the title when a parent row owns the hover label", () => {
    const markup = renderToStaticMarkup(
      createElement(StatusBadge, { compact: true, showTitle: false, status: "running" })
    );

    expect(markup).toContain(">R<");
    expect(markup).not.toContain('title="running"');
  });
});
