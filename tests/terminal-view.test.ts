import { describe, expect, test } from "bun:test";
import xterm from "@xterm/headless";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyAuthoritativeTerminalSize,
  applyTerminalFontSize,
  disableAlternateScreenBuffer,
  focusTerminalPane,
  TerminalView,
  terminalOptions
} from "../src/web/components/TerminalView.js";

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

  test("focuses xterm when the terminal pane is clicked", () => {
    let calls = 0;

    focusTerminalPane({ focus: () => calls++ });

    expect(calls).toBe(1);
  });

  test("does not refit after an authoritative daemon size changes the browser terminal grid", () => {
    const resizedTo: Array<{ cols: number; rows: number }> = [];

    applyAuthoritativeTerminalSize(
      {
        cols: 80,
        rows: 24,
        resize: (cols: number, rows: number) => resizedTo.push({ cols, rows })
      },
      120,
      40
    );

    expect(resizedTo).toEqual([{ cols: 120, rows: 40 }]);
  });

  test("redraws terminal history when the font size changes", () => {
    const refreshed: Array<{ start: number; end: number }> = [];
    let cleared = 0;
    let refits = 0;
    const term = {
      options: { fontSize: 13 },
      rows: 24,
      clearTextureAtlas: () => cleared++,
      refresh: (start: number, end: number) => refreshed.push({ start, end })
    };

    applyTerminalFontSize(term, 14, () => refits++);

    expect(term.options.fontSize).toBe(14);
    expect(cleared).toBe(1);
    expect(refreshed).toEqual([{ start: 0, end: 23 }]);
    expect(refits).toBe(1);
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
