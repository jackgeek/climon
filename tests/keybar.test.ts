import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KeyBar } from "../src/web/components/KeyBar.js";

function render(): string {
  return renderToStaticMarkup(createElement(KeyBar, { onSend: () => undefined }));
}

describe("KeyBar", () => {
  test("renders the modifier toggles and single-key sender", () => {
    const markup = render();

    expect(markup).toContain('role="toolbar"');
    expect(markup).toContain('aria-label="Special keys"');
    expect(markup).toContain("Ctrl");
    expect(markup).toContain("Alt/Opt");
    expect(markup).toContain("Shift");
    expect(markup).toContain('aria-label="Single key"');
    expect(markup).toContain(">Send<");
  });

  test("renders every special key in the curated order", () => {
    const markup = render();
    const expectedOrder = ["Esc", "Tab", "Enter", "Home", "Del", "←", "↑", "↓", "→", "End", "PgUp", "PgDn"];

    let cursor = -1;
    for (const label of expectedOrder) {
      const index = markup.indexOf(`>${label}<`, cursor + 1);
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  test("renders the full F1-F12 row", () => {
    const markup = render();

    for (let i = 1; i <= 12; i++) {
      expect(markup).toContain(`>F${i}<`);
    }
  });
});
