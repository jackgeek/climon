import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import xterm from "@xterm/headless";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyAuthoritativeTerminalSize,
  applyTerminalFontSize,
  applyTerminalScrollbackForSession,
  canRefitTerminalForSession,
  completeInitialReplay,
  captureTerminalText,
  stripTerminalDecorations,
  focusTerminalPane,
  mapWheelToScrollLines,
  reconnectDelayMs,
  refreshTerminalRender,
  refreshTerminalForReplay,
  resetTerminalForSession,
  shouldReconnectLiveAttachment,
  shouldHandleWheelAsScrollback,
  TerminalView,
  loadTerminalAddons,
  configureTerminalUnicode,
  createEmojiUnicodeProvider,
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
        session: null,
        visible: false,
        fontSize: 13,
        xtermTheme: { background: "#0d1117" },
        onFontSizeChange: () => {},
        serverConnected: true,
        serverReconnectToken: 0
      })
    );

    expect(markup).toContain("border:8px solid #729fcf");
    expect(markup).not.toContain("border-top:");
  });

  test("refits when the selected session changes even if terminal chrome is unchanged", () => {
    const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

    expect(source).toContain("}, [attachKey(session, visible), accentColor, maximized, visible]);");
  });

  test("reattaches live sessions after the dashboard server reconnects", () => {
    const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

    expect(source).toContain("serverReconnectToken: number");
    expect(source).toContain("}, [attachKey(session, visible), serverConnected, serverReconnectToken]);");
  });

  test("tracks the server reconnect token so a bumped token drives a fresh attach", () => {
    const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

    expect(source).toContain("lastServerReconnectTokenRef.current = serverReconnectToken;");
  });

  test("pauses reconnect retries while the server is unavailable", () => {
    const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

    expect(source).toContain("serverConnected: boolean;");
    expect(source).toContain("if (!visible || !serverConnected) {\n        return;\n      }");
    expect(source).toContain("serverConnectedRef.current");
  });

  test("refreshes scrollback for mid-session replays without resetting terminal modes", () => {
    const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

    // A browser-requested replay (e.g. after a clamp/fill toggle) arrives after
    // the initial replay completes; intercept it so scrollback is rebuilt with a
    // light refresh instead of being appended as live output.
    expect(source).toContain("const replayRequested = awaitingReplayRef.current;");
    expect(source).toContain("awaitingReplayRef.current = false;");
    expect(source).toContain("if (initialReplayCompleteRef.current && !replayRequested) {");
    expect(source).toContain(
      "} else if (replayRequested) {\n            // A mid-session replay (e.g. after a clamp/fill toggle) rebuilds\n            // scrollback without a full reset so mouse-tracking modes survive.\n            refreshTerminalForReplay(term);\n          }"
    );
  });

  test("requests a replay after a grid-change resize so scrollback is rebuilt for the new PTY size", () => {
    const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

    expect(source).toContain("replayAfterNextResizeRef.current = true;");
    expect(source).toContain('ws.send(JSON.stringify({ type: "replay" }));');
    expect(source).toContain('} else if (msg.type === "replay") {\n            awaitingReplayRef.current = true;\n          }');
  });

  test("refreshes the renderer when a hidden terminal becomes visible", () => {
    const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

    expect(source).toContain("if (visible) {\n      refreshTerminalRender(term);\n    }");
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

  async function cursorAdvance(grapheme: string): Promise<number> {
    const term = new Terminal({ cols: 40, rows: 3, allowProposedApi: true });
    configureTerminalUnicode(term, new Unicode11Addon());
    await writeTerminal(term, grapheme);
    const advance = term.buffer.active.cursorX;
    term.dispose();
    return advance;
  }

  test("installs the climon emoji-aware Unicode version", async () => {
    const term = new Terminal({ cols: 40, rows: 3, allowProposedApi: true });

    configureTerminalUnicode(term, new Unicode11Addon());

    expect(term.unicode.activeVersion).toBe("climon-emoji");
    term.dispose();
  });

  test("advances two cells for wide emoji so they do not eat a space", async () => {
    // Plain wide emoji and CJK are already correct under Unicode 11 — regression guards.
    expect(await cursorAdvance("😀")).toBe(2);
    expect(await cursorAdvance("⭐️")).toBe(2);
    expect(await cursorAdvance("世")).toBe(2);
    // ASCII must stay one cell.
    expect(await cursorAdvance("A")).toBe(1);
  });

  test("promotes emoji-presentation (VS16) sequences to two cells", async () => {
    // A narrow base + U+FE0F renders as a two-cell emoji; Unicode 11 alone leaves
    // these at width 1, desyncing the cursor and swallowing a space.
    expect(await cursorAdvance("❤️")).toBe(2);
    expect(await cursorAdvance("⚠️")).toBe(2);
    expect(await cursorAdvance("▶️")).toBe(2);
  });

  test("keeps keycap sequences to two cells", async () => {
    // Keycap = digit + U+FE0F + U+20E3; VS16 promotion plus the combining keycap join.
    expect(await cursorAdvance("1️⃣")).toBe(2);
  });

  test("keeps skin-tone emoji to two cells instead of summing the modifier", async () => {
    // Base emoji + skin-tone modifier (U+1F3FD) must stay a single two-cell cluster.
    expect(await cursorAdvance("👍🏽")).toBe(2);
  });

  test("leaves ZWJ sequences unchanged (documented out-of-scope limitation)", async () => {
    // ZWJ family clustering is intentionally not handled: font-dependent and risky.
    expect(await cursorAdvance("👨‍👩‍👧‍👦")).toBe(8);
  });

  test("emoji provider promotes VS16 and joins skin-tone modifiers, else delegates", () => {
    const createPropertyValue = (_state: number, width: number, shouldJoin: boolean): number =>
      (width << 1) | (shouldJoin ? 1 : 0);
    const extractWidth = (value: number): number => (value >> 1) & 0b11;
    const base = {
      wcwidth: (cp: number): 0 | 1 | 2 => (cp === 0x41 ? 1 : 2),
      charProperties: (): number => createPropertyValue(0, 1, false)
    };

    const provider = createEmojiUnicodeProvider(base, createPropertyValue, extractWidth);
    const narrowBase = createPropertyValue(0, 1, false);

    // VS16 after a narrow base -> width 2 + join.
    const vs16 = provider.charProperties(0xfe0f, narrowBase);
    expect(extractWidth(vs16)).toBe(2);
    expect(vs16 & 1).toBe(1);

    // Skin-tone modifier -> width 2 + join.
    const tone = provider.charProperties(0x1f3fd, createPropertyValue(0, 2, false));
    expect(extractWidth(tone)).toBe(2);
    expect(tone & 1).toBe(1);

    // Anything else delegates to the base provider.
    expect(provider.charProperties(0x41, 0)).toBe(createPropertyValue(0, 1, false));
    expect(provider.wcwidth(0x41)).toBe(1);
  });

  test("falls back to Unicode 11 without throwing when xterm internals are unavailable", () => {
    let version = "6";
    const stub = {
      loadAddon: () => {},
      unicode: {
        get activeVersion() {
          return version;
        },
        set activeVersion(value: string) {
          version = value;
        }
      }
    } as unknown as Parameters<typeof configureTerminalUnicode>[0];
    const addon = { activate: () => {}, dispose: () => {} } as unknown as Parameters<
      typeof configureTerminalUnicode
    >[1];

    expect(() => configureTerminalUnicode(stub, addon)).not.toThrow();
    expect(version).toBe("11");
  });

  test("wires emoji-aware Unicode width handling into the live terminal on creation", () => {
    const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

    expect(source).toContain("configureTerminalUnicode(term, new Unicode11Addon());");
  });

  test("installed FitAddon computes dimensions against the xterm 6 core without the removed viewport API", () => {
    // Regression guard for the addon-fit/xterm version mismatch: xterm 6 removed
    // `terminal._core.viewport`, which addon-fit@0.10 read as
    // `_core.viewport.scrollBarWidth` inside proposeDimensions(). That throw was
    // swallowed by fitNow()'s try/catch, so fit() became a silent no-op and the
    // terminal never re-fit its pane. A compatible addon-fit must compute
    // dimensions from the cell size and element geometry without touching the
    // removed viewport internal.
    const fit = new FitAddon();

    const element = { parentElement: {} as object };
    // Shaped like an xterm 6 terminal: `_core` has NO `viewport`.
    const fakeTerminal = {
      element,
      options: { scrollback: 1000, overviewRuler: { width: 0 } },
      _core: {
        _renderService: { dimensions: { css: { cell: { width: 9, height: 18 } } } }
      }
    };

    const computedStyle = (target: unknown) => ({
      getPropertyValue: (prop: string) => {
        if (target === element.parentElement) {
          if (prop === "height") return "600";
          if (prop === "width") return "800";
        }
        return "0";
      }
    });

    const priorWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { getComputedStyle: computedStyle };
    try {
      fit.activate(fakeTerminal as unknown as Parameters<FitAddon["activate"]>[0]);
      const dims = fit.proposeDimensions();
      expect(dims).toBeDefined();
      expect(dims?.rows).toBeGreaterThan(1);
      expect(dims?.cols).toBeGreaterThan(1);
    } finally {
      (globalThis as { window?: unknown }).window = priorWindow;
    }
  });

  test("focuses and refreshes xterm when the terminal pane is focused", () => {
    let focusCalls = 0;
    let refreshCalls = 0;

    focusTerminalPane({ focus: () => focusCalls++ }, () => refreshCalls++);

    expect(focusCalls).toBe(1);
    expect(refreshCalls).toBe(1);
  });

  test("captures the full terminal buffer as text, dropping trailing blank rows", async () => {
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    await writeTerminal(term, "line one\r\nline two\r\n");

    const captured = captureTerminalText(term as unknown as Parameters<typeof captureTerminalText>[0]);
    term.dispose();

    expect(captured).toContain("line one");
    expect(captured).toContain("line two");
    expect(captured.endsWith("line two")).toBe(true);
  });

  test("captureTerminalText tolerates a missing terminal", () => {
    expect(captureTerminalText(null)).toBe("");
  });

  test("stripTerminalDecorations replaces box/block glyphs with spaces to keep alignment", () => {
    const input = "cmd output      \u2502\nmore text here  \u2588";

    const cleaned = stripTerminalDecorations(input);

    expect(cleaned).toBe("cmd output\nmore text here");
    // Same column count before the (now-blank) decoration column is preserved.
    expect(cleaned.split("\n")[0]).toBe("cmd output");
  });

  test("stripTerminalDecorations preserves interior spacing when a mid-line glyph is removed", () => {
    const input = "a\u2502b";

    expect(stripTerminalDecorations(input)).toBe("a b");
  });

  test("repaints visible terminal rows without resetting the buffer", () => {
    const refreshed: Array<{ start: number; end: number }> = [];
    let cleared = 0;

    refreshTerminalRender({
      rows: 24,
      clearTextureAtlas: () => cleared++,
      refresh: (start: number, end: number) => refreshed.push({ start, end })
    });

    expect(cleared).toBe(1);
    expect(refreshed).toEqual([{ start: 0, end: 23 }]);
  });

  test("leaves mouse-tracking wheel events for xterm to forward to the terminal", () => {
    const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");

    expect(
      shouldHandleWheelAsScrollback({
        mouseTrackingMode: "vt200",
        activeBufferBaseY: 100
      })
    ).toBe(false);
    expect(source).not.toContain("scrollTerminalViewportElementOnWheel");
    expect(source).not.toContain("stopImmediatePropagation");
  });

  test("handles wheel events as local scrollback when normal scrollback exists", () => {
    expect(
      shouldHandleWheelAsScrollback({
        mouseTrackingMode: "none",
        activeBufferBaseY: 100
      })
    ).toBe(true);
  });

  test("maps wheel up to older scrollback lines in normal terminal mode", () => {
    expect(mapWheelToScrollLines({ deltaY: -120, deltaMode: 0 }, 20)).toBe(-6);
  });

  test("maps wheel down to newer scrollback lines in normal terminal mode", () => {
    expect(mapWheelToScrollLines({ deltaY: 120, deltaMode: 0 }, 20)).toBe(6);
  });

  test("maps page-mode wheel deltas to viewport-sized scrollback jumps", () => {
    expect(mapWheelToScrollLines({ deltaY: -1, deltaMode: 2 }, 24)).toBe(-23);
    expect(mapWheelToScrollLines({ deltaY: 1, deltaMode: 2 }, 24)).toBe(23);
  });

  test("leaves wheel events to xterm when the active buffer has no scrollback", () => {
    expect(
      shouldHandleWheelAsScrollback({
        mouseTrackingMode: "none",
        activeBufferBaseY: 0
      })
    ).toBe(false);
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

  test("can refresh replay scrollback without changing the current authoritative grid", () => {
    const calls: string[] = [];

    refreshTerminalForReplay({
      clear: () => calls.push("clear"),
      scrollToBottom: () => calls.push("scrollToBottom")
    });

    expect(calls).toEqual(["clear", "scrollToBottom"]);
  });

  test("keeps the viewport at the bottom after rebuilding replay scrollback", async () => {
    const term = new Terminal({ cols: 20, rows: 3, scrollback: 100, allowProposedApi: true, convertEol: true });

    await writeTerminal(term, "old1\nold2\nold3\nold4\n");
    term.scrollLines(-1);

    refreshTerminalForReplay(term);
    await writeTerminal(term, "new1\nnew2\nnew3\nnew4\nnew5\n");
    term.scrollToBottom();

    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
  });

  test("refreshes live replay scrollback without resetting terminal modes", () => {
    const calls: string[] = [];

    refreshTerminalForReplay({
      clear: () => calls.push("clear"),
      scrollToBottom: () => calls.push("scrollToBottom")
    });

    expect(calls).not.toContain("reset");
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

  test("reconnects only the current visible live attachment", () => {
    const session = { id: "s1", status: "running" } as const;

    expect(
      shouldReconnectLiveAttachment({
        session,
        sessionId: "s1",
        attachmentGeneration: 2,
        currentGeneration: 2,
        visible: true
      })
    ).toBe(true);
    expect(
      shouldReconnectLiveAttachment({
        session,
        sessionId: "s1",
        attachmentGeneration: 1,
        currentGeneration: 2,
        visible: true
      })
    ).toBe(false);
    expect(
      shouldReconnectLiveAttachment({
        session,
        sessionId: "s1",
        attachmentGeneration: 2,
        currentGeneration: 2,
        visible: false
      })
    ).toBe(false);
    expect(
      shouldReconnectLiveAttachment({
        session: { id: "s1", status: "completed" },
        sessionId: "s1",
        attachmentGeneration: 2,
        currentGeneration: 2,
        visible: true
      })
    ).toBe(false);
    expect(
      shouldReconnectLiveAttachment({
        session,
        sessionId: "s2",
        attachmentGeneration: 2,
        currentGeneration: 2,
        visible: true
      })
    ).toBe(false);
  });

  test("backs off browser terminal reconnects with a cap", () => {
    expect(reconnectDelayMs(-1)).toBe(250);
    expect(reconnectDelayMs(0)).toBe(250);
    expect(reconnectDelayMs(1)).toBe(500);
    expect(reconnectDelayMs(5)).toBe(5_000);
    expect(reconnectDelayMs(20)).toBe(5_000);
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

  test("repaints the viewport after the font-size reflow settles", () => {
    const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");
    // The font-size effect reflows via a refit that repaints once layout settles,
    // instead of repainting before the grid has reflowed to the new cell size.
    expect(source).toContain("applyTerminalFontSize(term, fontSize, refitThenRefresh)");
    // refitThenRefresh fits first, then repaints the whole viewport.
    expect(source).toContain("fitNow();\n        refreshTerminalRender(termRef.current);");
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

describe("TerminalHandle refresh", () => {
  test("exposes a repaint-only refresh() backed by refreshTerminalRender", () => {
    const source = readFileSync("src/web/components/TerminalView.tsx", "utf8");
    // Interface declares the method.
    expect(source).toContain("refresh: () => void;");
    // Imperative handle wires it to the repaint-only function (no refit).
    expect(source).toContain("refresh: () => refreshTerminalRender(termRef.current)");
  });
});
