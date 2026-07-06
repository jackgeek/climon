import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionMeta } from "../src/types.js";
import { applyVisualViewportLayout, clearVisualViewportLayout, scheduleTerminalRefit } from "../src/web/App.js";
import {
  MainHeader,
  ServerReconnectOverlay,
  TunnelReauthOverlay,
  activeConnectionOverlay,
  shouldShowServerReconnectOverlay,
  reconnectOverlayEntryMode,
  RECONNECT_VISIBILITY_GRACE_MS,
} from "../src/web/App.js";
import { shouldDeleteSessionWithoutDialog } from "../src/web/App.js";

function makeSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    command: ["bun", "run", "server"],
    displayCommand: "bun run server",
    cwd: "/repo",
    status: "running",
    priorityReason: "running",
    cols: 80,
    rows: 24,
    socketPath: "tcp://127.0.0.1:1234",
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    lastActivityAt: "2026-06-03T00:00:00.000Z",
    ...overrides
  };
}

describe("scheduleTerminalRefit", () => {
  test("sizes the mobile app shell from visual viewport CSS variables", () => {
    const source = readFileSync("src/web/App.tsx", "utf8");

    expect(source).toContain('height: "var(--climon-visual-viewport-height, 100dvh)"');
    expect(source).toContain('top: "var(--climon-visual-viewport-offset-top, 0px)"');
    expect(source).toContain('width: "var(--climon-visual-viewport-width, 100vw)"');
  });

  test("does not force the active terminal into clamped mode on mobile", () => {
    const source = readFileSync("src/web/App.tsx", "utf8");

    expect(source).not.toContain("resolveMobileViewMode");
    expect(source).not.toContain('viewMode={isMobile ? "clamped"');
    expect(source).not.toContain("viewModeLocked={isMobile}");
  });

  test("does not render a divider between the sidebar and main viewport", () => {
    const source = readFileSync("src/web/App.tsx", "utf8");

    expect(source).not.toContain("borderRight:");
  });

  test("renders a divider between the sidebar header and main header only", () => {
    const source = readFileSync("src/web/components/Sidebar.tsx", "utf8");

    expect(source).toContain("borderRight: `1px solid ${tokens.colorNeutralStroke1}`");
  });

  test("refits the terminal after layout settles across two animation frames", () => {
    let calls = 0;
    const scheduled: Array<(time: number) => void> = [];

    scheduleTerminalRefit(
      { refit: () => calls++ },
      (callback) => {
        scheduled.push((time) => callback(time));
        return 1;
      }
    );

    expect(calls).toBe(0);
    expect(scheduled).toHaveLength(1);

    const firstFrame = scheduled[0];
    if (!firstFrame) {
      throw new Error("Expected first terminal refit frame to be scheduled.");
    }
    firstFrame(0);

    expect(calls).toBe(0);
    expect(scheduled).toHaveLength(2);

    const secondFrame = scheduled[1];
    if (!secondFrame) {
      throw new Error("Expected second terminal refit frame to be scheduled.");
    }
    secondFrame(16);

    expect(calls).toBe(1);
  });

  test("mirrors visual viewport dimensions into CSS variables", () => {
    const properties = new Map<string, string>();
    const style = {
      setProperty: (name: string, value: string) => properties.set(name, value),
      removeProperty: (name: string) => {
        properties.delete(name);
      }
    };

    applyVisualViewportLayout(
      {
        height: 510.5,
        width: 390,
        offsetTop: 42,
        offsetLeft: 0
      },
      style
    );

    expect(properties.get("--climon-visual-viewport-height")).toBe("510.5px");
    expect(properties.get("--climon-visual-viewport-width")).toBe("390px");
    expect(properties.get("--climon-visual-viewport-offset-top")).toBe("42px");
    expect(properties.get("--climon-visual-viewport-offset-left")).toBe("0px");

    clearVisualViewportLayout(style);

    expect(properties.size).toBe(0);
  });

  describe("MainHeader", () => {
    test("renders the active session status pill after the session name", () => {
      const markup = renderToStaticMarkup(
        createElement(MainHeader, {
          activeSession: makeSession({ name: "API server", status: "needs-attention" }),
          hidden: false
        })
      );

      const nameIndex = markup.indexOf("API server");
      const statusIndex = markup.indexOf("needs attention");
      const idIndex = markup.indexOf(">s1<");

      expect(nameIndex).toBeGreaterThan(-1);
      expect(statusIndex).toBeGreaterThan(nameIndex);
      expect(idIndex).toBeGreaterThan(statusIndex);
    });
  });

  describe("ServerReconnectOverlay", () => {
    test("is only shown while reconnecting and armed", () => {
      expect(shouldShowServerReconnectOverlay("reconnecting", true)).toBe(true);
      expect(shouldShowServerReconnectOverlay("reconnecting", false)).toBe(false);
      expect(shouldShowServerReconnectOverlay("connecting", true)).toBe(false);
      expect(shouldShowServerReconnectOverlay("connecting", false)).toBe(false);
      expect(shouldShowServerReconnectOverlay("connected", true)).toBe(false);
      expect(shouldShowServerReconnectOverlay("connected", false)).toBe(false);
    });

    test("entry mode is immediate only when the page recently became visible", () => {
      expect(reconnectOverlayEntryMode({ pageVisible: true, msSinceVisible: 0 })).toBe("immediate");
      expect(
        reconnectOverlayEntryMode({ pageVisible: true, msSinceVisible: RECONNECT_VISIBILITY_GRACE_MS })
      ).toBe("immediate");
      expect(
        reconnectOverlayEntryMode({ pageVisible: true, msSinceVisible: RECONNECT_VISIBILITY_GRACE_MS + 1 })
      ).toBe("delayed");
      expect(reconnectOverlayEntryMode({ pageVisible: false, msSinceVisible: 0 })).toBe("delayed");
    });

    test("shows a calm reconnecting message", () => {
      const markup = renderToStaticMarkup(createElement(ServerReconnectOverlay));

      expect(markup).toContain('role="alert"');
      expect(markup).toContain('tabindex="-1"');
      expect(markup).toContain("Reconnecting");
      expect(markup).toContain("Re-establishing connection to the climon server...");
    });

    test("refreshes all sessions before reattaching terminals after a server reconnect", () => {
      const source = readFileSync("src/web/App.tsx", "utf8");

      expect(source).toContain("async function refreshSessionsAfterReconnect(): Promise<void>");
      expect(source).toContain(
        'if (serverConnectionStateRef.current === "reconnecting") {\n        void refreshSessionsAfterReconnect();\n        return;\n      }'
      );
      expect(source).toContain(
        "setSessions(loadedSessions);\n        if (markServerConnected()) {\n          setServerReconnectToken"
      );
    });
  });

  test("does nothing when there is no terminal handle", () => {
    let scheduled = false;

    scheduleTerminalRefit(null, (callback) => {
      scheduled = true;
      callback(0);
      return 1;
    });

    expect(scheduled).toBe(false);
  });

  test("deletes terminal sessions without opening the close dialog", () => {
    expect(shouldDeleteSessionWithoutDialog(makeSession({ status: "completed" }))).toBe(true);
    expect(shouldDeleteSessionWithoutDialog(makeSession({ status: "failed" }))).toBe(true);
    expect(shouldDeleteSessionWithoutDialog(makeSession({ status: "disconnected" }))).toBe(true);
    expect(shouldDeleteSessionWithoutDialog(makeSession({ status: "running" }))).toBe(false);
  });

  describe("compose staging area handlers", () => {
    test("Insert sends raw text and clears the staging text", () => {
      const source = readFileSync("src/web/App.tsx", "utf8");

      // Insert: raw text, then clear.
      expect(source).toContain("onComposeInsert={(text) => {\n                  terminalRef.current?.sendInput(text);\n                  setComposeText(\"\");");
      expect(source).not.toContain("onComposeInsertRun");
    });

    test("Cancel closes the panel without clearing the staging text", () => {
      const source = readFileSync("src/web/App.tsx", "utf8");

      const cancelStart = source.indexOf("onComposeCancel={() => {");
      expect(cancelStart).toBeGreaterThan(-1);
      const cancelEnd = source.indexOf("}}", cancelStart);
      const cancelBody = source.slice(cancelStart, cancelEnd);
      // Cancel must not reset the staged text (retention lets the user peek at the terminal).
      expect(cancelBody).not.toContain('setComposeText("")');
    });

    test("hides the exit-fullscreen button while a fullscreen overlay (compose or selection) is visible", () => {
      const source = readFileSync("src/web/App.tsx", "utf8");

      // Tied to the overlays' own render condition so the user is never trapped
      // in fullscreen if the session stops being live mid-compose/selection.
      expect(source).toContain(
        "const composeOverlayVisible = keyBarAvailable && panelView === \"compose\";"
      );
      expect(source).toContain(
        "const selectionOverlayVisible = keyBarAvailable && panelView === \"selection\";"
      );
      expect(source).toContain(
        "const fullscreenOverlayVisible = composeOverlayVisible || selectionOverlayVisible;"
      );
      expect(source).toContain("{maximized && !fullscreenOverlayVisible && (");
    });
  });

  describe("touch-based keybar availability", () => {
    test("derives keyBarDockedInline from touch-primary on wide (non-stacked) viewports", () => {
      const source = readFileSync("src/web/App.tsx", "utf8");

      expect(source).toContain("const isTouchPrimary = useIsTouchPrimary();");
      expect(source).toContain("const keyBarDockedInline = isTouchPrimary && !isMobile;");
    });

    test("passes showLabels to the keybar based on viewport width", () => {
      const source = readFileSync("src/web/App.tsx", "utf8");

      expect(source).toContain("showLabels={!isMobile}");
    });

    test("keybar availability requires maximized OR docked inline for a live session", () => {
      const source = readFileSync("src/web/App.tsx", "utf8");

      expect(source).toContain(
        "(maximized || keyBarDockedInline) && activeSession !== null && isLiveStatus(activeSession.status)"
      );
      expect(source).toContain('{panelView !== "closed" && keyBarAvailable && (');
    });

    test("the tap-catching backdrop renders in fullscreen or docked inline", () => {
      const source = readFileSync("src/web/App.tsx", "utf8");

      expect(source).toContain(
        "(maximized || keyBarDockedInline) && !(keyBarPinned && panelView === \"chooser\") && ("
      );
    });

    test("leaving fullscreen keeps the inline-docked keybar open on wide touch", () => {
      const source = readFileSync("src/web/App.tsx", "utf8");

      expect(source).toContain("if (!maximized && !keyBarDockedInline) {");
    });

    test("the reveal swipe is active while maximized or docked inline", () => {
      const source = readFileSync("src/web/App.tsx", "utf8");

      expect(source).toContain("if (!maximized && !keyBarDockedInline) {\n      return;\n    }");
    });
  });
});

describe("tab refocus terminal refresh", () => {
  test("repaints on refocus and focuses only on desktop", () => {
    const source = readFileSync("src/web/App.tsx", "utf8");

    const onVisibilityStart = source.indexOf("const onVisibility = ");
    expect(onVisibilityStart).toBeGreaterThan(-1);
    const onVisibilityEnd = source.indexOf("document.addEventListener(\"visibilitychange\"", onVisibilityStart);
    expect(onVisibilityEnd).toBeGreaterThan(onVisibilityStart);
    const onVisibilityBody = source.slice(onVisibilityStart, onVisibilityEnd);

    // Marks the visible branch.
    expect(onVisibilityBody).toContain("becameVisibleAtRef.current = Date.now();");

    // Repaint without focus on mobile (no soft keyboard); focus on desktop.
    // Assert branch ORDER so a `!isMobile` inversion (focus on mobile) is caught:
    // the mobile `if (isMobile)` branch with term.refresh() must come before the
    // desktop `else` branch with term.focus().
    const ifMobileIdx = onVisibilityBody.indexOf("if (isMobile) {");
    const refreshIdx = onVisibilityBody.indexOf("term.refresh();");
    const elseIdx = onVisibilityBody.indexOf("} else {", ifMobileIdx);
    const focusIdx = onVisibilityBody.indexOf("term.focus();");
    expect(ifMobileIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(ifMobileIdx);
    expect(elseIdx).toBeGreaterThan(refreshIdx);
    expect(focusIdx).toBeGreaterThan(elseIdx);

    // The handler reads isMobile, so it must be a dependency of the effect.
    expect(source).toContain("}, [armReconnectOverlay, isMobile]);");
  });
});

describe("activeConnectionOverlay", () => {
  test("auth overlay wins over the generic reconnect overlay", () => {
    expect(
      activeConnectionOverlay({ tunnelAuthRequired: true, reconnectOverlayVisible: true })
    ).toBe("auth");
  });

  test("falls back to reconnect when only reconnect is active", () => {
    expect(
      activeConnectionOverlay({ tunnelAuthRequired: false, reconnectOverlayVisible: true })
    ).toBe("reconnect");
  });

  test("none when neither is active", () => {
    expect(
      activeConnectionOverlay({ tunnelAuthRequired: false, reconnectOverlayVisible: false })
    ).toBe("none");
  });
});

describe("TunnelReauthOverlay", () => {
  test("renders the expired-session prompt and a sign-in action", () => {
    const html = renderToStaticMarkup(createElement(TunnelReauthOverlay, { onReauth: () => {} }));
    expect(html).toContain("Session expired");
    expect(html).toContain("Sign in again");
  });
});
