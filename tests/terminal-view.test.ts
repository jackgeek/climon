import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import xterm from "@xterm/headless";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyAuthoritativeTerminalSize,
  applyTerminalFontSize,
  applyTerminalScrollbackForSession,
  canRefitTerminalForSession,
  completeInitialReplay,
  focusTerminalPane,
  moveTouchScroll,
  resetTerminalForSession,
  startTouchScroll,
  TerminalView,
  loadTerminalAddons,
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

  test("refits when the selected session changes even if terminal chrome is unchanged", () => {
    const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

    expect(source).toContain("}, [attachKey(session, visible), accentColor, maximized, visible, viewMode]);");
  });

  test("keeps browser-side scrollback for live terminal mouse wheel history", () => {
    expect(terminalOptions.scrollback).toBe(10_000);
  });

  test("keeps browser-side scrollback for live sessions and captured terminal replay", () => {
    const term = { options: { scrollback: 0 } };

    applyTerminalScrollbackForSession(term, { status: "running" });
    expect(term.options.scrollback).toBe(10_000);

    applyTerminalScrollbackForSession(term, { status: "completed" });
    expect(term.options.scrollback).toBe(10_000);

    applyTerminalScrollbackForSession(term, null);
    expect(term.options.scrollback).toBe(10_000);
  });

  test("hides the xterm viewport scrollbar while retaining scrollback", () => {
    const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

    expect(source).toContain('"& .xterm-viewport"');
    expect(source).toContain('scrollbarWidth: "none"');
    expect(source).toContain('msOverflowStyle: "none"');
    expect(source).toContain('"& .xterm-viewport::-webkit-scrollbar"');
    expect(source).toContain('display: "none"');
    expect(terminalOptions.scrollback).toBe(10_000);
  });

  test("loads fit and web link addons", () => {
    const loaded: string[] = [];
    const fitAddon = { activate: () => {}, dispose: () => {} };
    const webLinksAddon = { activate: () => {}, dispose: () => {} };

    loadTerminalAddons(
      { loadAddon: (addon) => loaded.push(addon === fitAddon ? "fit" : "web-links") },
      fitAddon,
      webLinksAddon
    );

    expect(loaded).toEqual(["fit", "web-links"]);
  });

  test("focuses xterm when the terminal pane is clicked", () => {
    let calls = 0;

    focusTerminalPane({ focus: () => calls++ });

    expect(calls).toBe(1);
  });

  test("does not capture wheel events so xterm can forward them to terminal mouse tracking", () => {
    const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

    expect(source).not.toContain("addEventListener(\"wheel\"");
    expect(source).not.toContain("scrollTerminalViewportElementOnWheel");
    expect(source).not.toContain("stopImmediatePropagation");
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

  test("resizes to the selected session grid before clearing for replay", () => {
    const calls: string[] = [];

    resetTerminalForSession(
      {
        cols: 120,
        rows: 40,
        resize: (cols: number, rows: number) => calls.push(`resize:${cols}x${rows}`),
        reset: () => calls.push("reset")
      },
      { cols: 80, rows: 24 }
    );

    expect(calls).toEqual(["resize:80x24", "reset"]);
  });

  test("does not refit while a selected session replay depends on its captured grid", () => {
    expect(canRefitTerminalForSession({ status: "running" }, true)).toBe(true);
    expect(canRefitTerminalForSession({ status: "running" }, false)).toBe(false);
    expect(canRefitTerminalForSession({ status: "completed" }, false)).toBe(false);
  });

  test("ignores stale initial replay callbacks from a previous session", () => {
    let replayComplete = false;
    let refits = 0;

    completeInitialReplay(1, 2, () => {
      replayComplete = true;
    }, () => refits++);

    expect(replayComplete).toBe(false);
    expect(refits).toBe(0);

    completeInitialReplay(2, 2, () => {
      replayComplete = true;
    }, () => refits++);

    expect(replayComplete).toBe(true);
    expect(refits).toBe(1);
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

  test("keeps alternate-screen output out of normal browser scrollback", async () => {
    const term = new Terminal({ cols: 20, rows: 3, scrollback: 100, allowProposedApi: true });

    await writeTerminal(term, "normal1\r\nnormal2\r\nnormal3\r\nnormal4\r\n");
    await writeTerminal(term, "\x1b[?1049halt1\r\nalt2\r\nalt3\r\nalt4\r\n\x1b[?1049l");

    expect(term.buffer.active.type).toBe("normal");
    expect(term.buffer.active.baseY).toBeGreaterThan(0);
    const history = Array.from({ length: term.buffer.active.length }, (_, index) =>
      term.buffer.active.getLine(index)?.translateToString(true)
    );
    expect(history).toContain("normal4");
    expect(history).not.toContain("alt1");
    expect(history).not.toContain("alt4");
  });
});

describe("touch scroll gesture", () => {
  test("arms only for single-finger touches", () => {
    expect(startTouchScroll(1, 100)).toEqual({ active: true, lastY: 100 });
    expect(startTouchScroll(2, 100)).toEqual({ active: false, lastY: 100 });
    expect(startTouchScroll(0, 100)).toEqual({ active: false, lastY: 100 });
  });

  test("swiping up scrolls toward newer output (positive deltaY)", () => {
    const start = startTouchScroll(1, 200);
    const move = moveTouchScroll(start, 1, 150);

    expect(move.deltaY).toBe(50);
    expect(move.state).toEqual({ active: true, lastY: 150 });
  });

  test("swiping down scrolls toward older history (negative deltaY)", () => {
    const start = startTouchScroll(1, 100);
    const move = moveTouchScroll(start, 1, 175);

    expect(move.deltaY).toBe(-75);
    expect(move.state).toEqual({ active: true, lastY: 175 });
  });

  test("delta magnitude equals the pixels moved since the previous event", () => {
    const first = moveTouchScroll(startTouchScroll(1, 300), 1, 280);
    expect(first.deltaY).toBe(20);

    const second = moveTouchScroll(first.state, 1, 290);
    expect(second.deltaY).toBe(-10);
  });

  test("multi-touch disarms the gesture and emits no scroll", () => {
    const move = moveTouchScroll(startTouchScroll(1, 100), 2, 150);

    expect(move.deltaY).toBe(0);
    expect(move.state.active).toBe(false);
  });

  test("a gesture that started multi-finger stays disarmed", () => {
    const move = moveTouchScroll(startTouchScroll(2, 100), 1, 150);

    expect(move.deltaY).toBe(0);
    expect(move.state.active).toBe(false);
  });
});
