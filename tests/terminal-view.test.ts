import { describe, expect, test } from "bun:test";
import xterm from "@xterm/headless";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { disableAlternateScreenBuffer, TerminalView, terminalOptions } from "../src/web/components/TerminalView.js";

const { Terminal } = xterm;

function writeTerminal(term: InstanceType<typeof Terminal>, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

describe("TerminalView", () => {
  test("renders the session color accent around the terminal pane", () => {
    const markup = renderToStaticMarkup(
      createElement(TerminalView, {
        accentColor: "blue",
        maximized: false,
        onViewModeChange: () => {},
        session: null,
        visible: false,
        viewMode: "clamped"
      })
    );

    expect(markup).toContain("border:8px solid #729fcf");
    expect(markup).not.toContain("border-top:");
  });

  test("keeps enough terminal scrollback for long-running command output", () => {
    expect(terminalOptions.scrollback).toBeGreaterThanOrEqual(10_000);
  });

  test("keeps browser history scrollable when a command uses the alternate screen", async () => {
    const term = new Terminal({ cols: 20, rows: 3, scrollback: 100, allowProposedApi: true });
    disableAlternateScreenBuffer(term);

    await writeTerminal(term, "normal1\r\nnormal2\r\nnormal3\r\nnormal4\r\n");
    await writeTerminal(term, "\x1b[?1049halt1\r\nalt2\r\nalt3\r\nalt4\r\n");

    expect(term.buffer.active.type).toBe("normal");
    expect(term.buffer.active.baseY).toBeGreaterThan(0);

    const bottom = term.buffer.active.viewportY;
    term.scrollLines(-2);

    expect(term.buffer.active.viewportY).toBeLessThan(bottom);
  });
});
