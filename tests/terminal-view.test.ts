import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalView } from "../src/web/components/TerminalView.js";

describe("TerminalView", () => {
  test("renders the session color accent around the terminal pane", () => {
    const markup = renderToStaticMarkup(
      createElement(TerminalView, {
        accentColor: "blue",
        maximized: false,
        session: null,
        visible: false
      })
    );

    expect(markup).toContain("border:4px solid #729fcf");
    expect(markup).not.toContain("border-top:");
  });
});
