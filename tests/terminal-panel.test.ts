import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { terminalPanelArrowData, TerminalPanel, type TerminalPanelView } from "../src/web/components/TerminalPanel.js";

function renderPanel(overrides: Partial<Parameters<typeof TerminalPanel>[0]> = {}): string {
  const props = {
    view: "compose" as TerminalPanelView,
    fontSize: 14,
    composeText: "hello world",
    onSelect: () => undefined,
    onAdjustFont: () => undefined,
    onComposeTextChange: () => undefined,
    onComposeInsert: () => undefined,
    onComposeCancel: () => undefined,
    onSend: () => undefined,
    ...overrides
  };
  return renderToStaticMarkup(createElement(TerminalPanel, props));
}

describe("TerminalPanel", () => {
  test("maps chooser arrow buttons to page key input", () => {
    expect(terminalPanelArrowData("up")).toBe("\x1b[5~");
    expect(terminalPanelArrowData("down")).toBe("\x1b[6~");
  });

  test("wires chooser arrow buttons to page key input", () => {
    const source = readFileSync("src/web/components/TerminalPanel.tsx", "utf8");

    expect(source).toContain('aria-label="Send PageDown"');
    expect(source).toContain('onClick={() => onSend(terminalPanelArrowData("down"))}');
    expect(source).toContain('aria-label="Send PageUp"');
    expect(source).toContain('onClick={() => onSend(terminalPanelArrowData("up"))}');
  });

  test("chooser buttons keep accessible labels for the icon-only breakpoint", () => {
    const source = readFileSync("src/web/components/TerminalPanel.tsx", "utf8");

    expect(source).toContain('aria-label="Keyboard"');
    expect(source).toContain('aria-label="Font size"');
    expect(source).toContain('aria-label="Compose text"');
    expect(source).toContain('onClick={() => onSelect("compose")}');
    // Visible labels live in a span so CSS can collapse them to icon-only.
    expect(source).toContain('<span className={styles.chooserLabel}>Keyboard</span>');
    expect(source).toContain('<span className={styles.chooserLabel}>Font size</span>');
    expect(source).toContain('<span className={styles.chooserLabel}>Composer</span>');
  });

  test("chooser buttons render responsive text labels", () => {
    const markup = renderPanel({ view: "chooser" });

    expect(markup).toContain("Keyboard");
    expect(markup).toContain("Font size");
    expect(markup).toContain("Composer");
    // Labels are wrapped so CSS can hide them (icon-only) on narrow viewports.
    expect(markup).toContain(">Composer</span>");
  });

  test("chooser labels are hidden at the mobile breakpoint via CSS", () => {
    const source = readFileSync("src/web/components/TerminalPanel.tsx", "utf8");

    expect(source).toContain("chooserLabel:");
    expect(source).toContain("[MOBILE_MEDIA_QUERY_RULE]: {");
    expect(source).toContain('display: "none"');
  });

  test("compose view renders textarea, staged text, and actions", () => {
    const markup = renderPanel();

    expect(markup).toContain('aria-label="Compose text"');
    expect(markup).toContain('aria-label="Text to insert"');
    expect(markup).toContain("hello world");
    expect(markup).toContain(">Cancel<");
    expect(markup).toContain(">Insert<");
  });

  test("compose insert button is disabled when text is empty", () => {
    const markup = renderPanel({ composeText: "" });

    const disabledCount = (markup.match(/disabled=""|disabled/g) ?? []).length;
    expect(disabledCount).toBeGreaterThanOrEqual(1);
  });

  test("compose action buttons wire to insert and cancel handlers", () => {
    const source = readFileSync("src/web/components/TerminalPanel.tsx", "utf8");

    expect(source).toContain("onClick={() => onComposeInsert(composeText)}");
    expect(source).toContain("onClick={() => onComposeCancel()}");
  });
});
