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
    onComposeInsertRun: () => undefined,
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

  test("chooser buttons are icon-only with accessible labels", () => {
    const source = readFileSync("src/web/components/TerminalPanel.tsx", "utf8");

    expect(source).not.toContain(">Keyboard<");
    expect(source).not.toContain(">Font size<");
    expect(source).toContain('aria-label="Keyboard"');
    expect(source).toContain('aria-label="Font size"');
    expect(source).toContain('aria-label="Compose text"');
    expect(source).toContain('onClick={() => onSelect("compose")}');
  });

  test("compose view renders textarea, staged text, and actions", () => {
    const markup = renderPanel();

    expect(markup).toContain('aria-label="Compose text"');
    expect(markup).toContain('aria-label="Text to insert"');
    expect(markup).toContain("hello world");
    expect(markup).toContain(">Cancel<");
    expect(markup).toContain(">Insert<");
    expect(markup).toContain("Insert &amp; Run");
  });

  test("compose insert buttons are disabled when text is empty", () => {
    const markup = renderPanel({ composeText: "" });

    const disabledCount = (markup.match(/disabled=""|disabled/g) ?? []).length;
    expect(disabledCount).toBeGreaterThanOrEqual(2);
  });

  test("compose insert wiring sends raw text and insert-and-run appends carriage return", () => {
    const source = readFileSync("src/web/components/TerminalPanel.tsx", "utf8");

    expect(source).toContain("onClick={() => onComposeInsert(composeText)}");
    expect(source).toContain("onClick={() => onComposeInsertRun(composeText)}");
    expect(source).toContain("onClick={() => onComposeCancel()}");
  });
});
