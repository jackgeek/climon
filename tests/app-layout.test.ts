import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionMeta } from "../src/types.js";
import { applyVisualViewportLayout, clearVisualViewportLayout, scheduleTerminalRefit } from "../src/web/App.js";
import {
  MainHeader,
  ServerReconnectOverlay,
  shouldShowServerReconnectOverlay,
  type ServerConnectionState
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
    test("is only shown after an established server connection is lost", () => {
      const visibleStates: ServerConnectionState[] = ["reconnecting"];
      const hiddenStates: ServerConnectionState[] = ["connecting", "connected"];

      for (const state of visibleStates) {
        expect(shouldShowServerReconnectOverlay(state)).toBe(true);
      }
      for (const state of hiddenStates) {
        expect(shouldShowServerReconnectOverlay(state)).toBe(false);
      }
    });

    test("alerts that the server connection was lost and reconnects automatically", () => {
      const markup = renderToStaticMarkup(createElement(ServerReconnectOverlay));

      expect(markup).toContain('role="alert"');
      expect(markup).toContain('tabindex="-1"');
      expect(markup).toContain("Connection lost");
      expect(markup).toContain("The climon server connection was lost. Reconnecting automatically...");
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
});
