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
    selectionText: "",
    stripDecorations: false,
    showLabels: true,
    showSelect: false,
    onSelect: () => undefined,
    onAdjustFont: () => undefined,
    onComposeTextChange: () => undefined,
    onComposeInsert: () => undefined,
    onComposeCancel: () => undefined,
    onToggleStripDecorations: () => undefined,
    onSelectionClose: () => undefined,
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

  test("chooser buttons keep accessible labels for the icon-only state", () => {
    const source = readFileSync("src/web/components/TerminalPanel.tsx", "utf8");

    expect(source).toContain('aria-label="Keyboard"');
    expect(source).toContain('aria-label="Font size"');
    expect(source).toContain('aria-label="Compose text"');
    expect(source).toContain('onClick={() => onSelect("compose")}');
    // Labels are only rendered as children when showLabels is set, so the
    // buttons collapse to true icon-only Fluent buttons on narrow viewports.
    expect(source).toContain('{showLabels ? <span className={styles.chooserLabel}>Keyboard</span> : undefined}');
    expect(source).toContain('{showLabels ? <span className={styles.chooserLabel}>Font size</span> : undefined}');
    expect(source).toContain('{showLabels ? <span className={styles.chooserLabel}>Composer</span> : undefined}');
  });

  test("chooser buttons render text labels when showLabels is true", () => {
    const markup = renderPanel({ view: "chooser", showLabels: true });

    expect(markup).toContain("Keyboard");
    expect(markup).toContain("Font size");
    expect(markup).toContain(">Composer</span>");
  });

  test("chooser buttons omit text labels when showLabels is false", () => {
    const markup = renderPanel({ view: "chooser", showLabels: false });

    expect(markup).not.toContain("Composer");
    expect(markup).not.toContain(">Keyboard</span>");
    expect(markup).not.toContain(">Font size</span>");
    // Accessible names are still present via aria-label for the icon-only state.
    expect(markup).toContain('aria-label="Keyboard"');
    expect(markup).toContain('aria-label="Compose text"');
  });

  test("chooser shows the Select button only when showSelect is set", () => {
    const withSelect = renderPanel({ view: "chooser", showSelect: true });
    const withoutSelect = renderPanel({ view: "chooser", showSelect: false });

    expect(withSelect).toContain('aria-label="Select text"');
    expect(withoutSelect).not.toContain('aria-label="Select text"');
  });

  test("selection view renders captured text in a read-only textarea with a strip toggle", () => {
    const markup = renderPanel({
      view: "selection",
      selectionText: "captured line one\ncaptured line two",
      stripDecorations: false
    });

    expect(markup).toContain("captured line one");
    expect(markup).toContain('aria-label="Captured terminal text"');
    expect(markup).toContain("readOnly");
    expect(markup).toContain("Strip scrollbars &amp; decorations");
    expect(markup).toContain("Select all");
    expect(markup).toContain("Close");
  });

  test("selection view reflects the checked strip-decorations state", () => {
    const checked = renderPanel({ view: "selection", selectionText: "x", stripDecorations: true });
    const unchecked = renderPanel({ view: "selection", selectionText: "x", stripDecorations: false });

    expect(checked).toContain('type="checkbox"');
    expect(checked).toContain('checked=""');
    expect(unchecked).not.toContain('checked=""');
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

  test("compose view selects pre-existing text when opened", () => {
    const source = readFileSync("src/web/components/TerminalPanel.tsx", "utf8");

    expect(source).toContain("const composeTextareaRef = useRef<HTMLTextAreaElement | null>(null);");
    expect(source).toContain("textarea={{ ref: composeTextareaRef, style: { height: \"100%\" } }}");
    expect(source).toContain("el.setSelectionRange(0, el.value.length);");
  });

  test("compose action buttons wire to insert and cancel handlers", () => {
    const source = readFileSync("src/web/components/TerminalPanel.tsx", "utf8");

    expect(source).toContain("onClick={() => onComposeInsert(composeText)}");
    expect(source).toContain("onClick={() => onComposeCancel()}");
  });
});
