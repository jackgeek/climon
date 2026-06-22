import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, type CSSProperties, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as RealIcons from "@fluentui/react-icons";
import type { SessionMeta } from "../src/types.js";

// Stub every real icon export so this file's `mock.module` does not drop named
// exports that other components import. `mock.module` is global for the whole
// test run, so a partial mock here would break unrelated test files (e.g. the
// missing `ChevronDown24Regular`/`ChevronDoubleRightRegular` exports).
const iconStubs = Object.fromEntries(
  Object.keys(RealIcons).map((name) => [name, () => createElement("span", null)])
);

type FluentProps = {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  title?: string;
  "aria-label"?: string;
  icon?: ReactNode;
  disabled?: boolean;
};

mock.module("@fluentui/react-components", () => ({
  Badge: ({ children, className, title }: FluentProps) => createElement("div", { className, title }, children),
  Button: ({ children, className, title, "aria-label": ariaLabel, icon, disabled }: FluentProps) =>
    createElement(
      "button",
      { className, title, "aria-label": ariaLabel, "data-disabled": disabled ? "true" : undefined },
      icon,
      children
    ),
  Text: ({ children, className, title }: FluentProps) => createElement("div", { className, title }, children),
  makeStyles: () => () => ({
    active: "active",
    activeCmd: "activeCmd",
    activeMarker: "activeMarker",
    close: "close",
    cmd: "cmd",
    compactMeta: "compactMeta",
    compactRoot: "compactRoot",
    editBtn: "editBtn",
    lockBtn: "lockBtn",
    maximize: "maximize",
    meta: "meta",
    newBtn: "newBtn",
    origin: "origin",
    pauseBtn: "pauseBtn",
    root: "root"
  }),
  mergeClasses: (...classes: Array<string | false | undefined>) => classes.filter(Boolean).join(" "),
  tokens: {
    borderRadiusSmall: "2px",
    colorNeutralBackground1Hover: "#eee",
    colorNeutralBackground1Selected: "#ddd",
    colorNeutralBackground3: "#f5f5f5",
    colorNeutralForeground2: "#333",
    colorNeutralForeground3: "#666",
    colorNeutralStroke2: "#ccc",
    fontFamilyMonospace: "monospace"
  }
}));

mock.module("@fluentui/react-icons", () => ({
  ...iconStubs,
  LockClosed16Regular: () => createElement("span", { "data-icon": "lock-closed" }),
  LockOpen16Regular: () => createElement("span", { "data-icon": "lock-open" })
}));

const { SessionItem, sessionAccessibleLabel, sessionDisplayTitle } = await import(
  "../src/web/components/SessionItem.js"
);

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

describe("sessionDisplayTitle", () => {
  test("uses the custom session name when present", () => {
    expect(sessionDisplayTitle({ name: "API server", displayCommand: "bun run server" })).toBe("API server");
  });

  test("falls back to displayCommand when the custom name is missing", () => {
    expect(sessionDisplayTitle({ displayCommand: "bun test tests/config.test.ts" })).toBe(
      "bun test tests/config.test.ts"
    );
  });

  test("falls back to displayCommand when the custom name is an empty string", () => {
    expect(sessionDisplayTitle({ name: "", displayCommand: "npm run dev" })).toBe("npm run dev");
  });
});

describe("sessionAccessibleLabel", () => {
  test("uses the visible title in expanded mode", () => {
    expect(
      sessionAccessibleLabel(
        { name: "API server", displayCommand: "bun run server", status: "running" },
        false
      )
    ).toBeUndefined();
  });

  test("includes the session title and full status in compact mode", () => {
    expect(
      sessionAccessibleLabel(
        { name: "API server", displayCommand: "bun run server", status: "needs-attention" },
        true
      )
    ).toBe("API server, needs attention");
  });

  test("falls back to displayCommand for compact labels when no custom name is present", () => {
    expect(
      sessionAccessibleLabel(
        { displayCommand: "bun test tests/config.test.ts", status: "completed" },
        true
      )
    ).toBe("bun test tests/config.test.ts, completed");
  });
});

describe("SessionItem compact rendering", () => {
  test("keeps the session title as the only compact hover title", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionItem, {
        active: false,
        compact: true,
        session: makeSession({ name: "API server" }),
        onClose: () => {},
        onEdit: () => {},
        onMaximize: () => {},
        onNew: () => {},
        onPauseToggle: () => {},
        onSelect: () => {}
      })
    );

    expect(markup).toContain('title="API server"');
    expect(markup).not.toContain('title="running"');
  });

  test("uses the normal color accent when inactive", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionItem, {
        active: false,
        compact: true,
        session: makeSession({ color: "blue", name: "API server" }),
        onClose: () => {},
        onEdit: () => {},
        onMaximize: () => {},
        onNew: () => {},
        onPauseToggle: () => {},
        onSelect: () => {}
      })
    );

    expect(markup).toContain("border-right:4px solid #3465a4");
    expect(markup).not.toContain("#729fcf");
  });

  test("uses a 4px highlighted color accent and inward triangle when active", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionItem, {
        active: true,
        compact: true,
        session: makeSession({ color: "blue", name: "API server" }),
        onClose: () => {},
        onEdit: () => {},
        onMaximize: () => {},
        onNew: () => {},
        onPauseToggle: () => {},
        onSelect: () => {}
      })
    );

    expect(markup).toContain("border:4px solid #729fcf");
    expect(markup).toContain("climon-active-marker");
    expect(markup).toContain("border-right:12px solid #729fcf");
    expect(markup).not.toContain("#3465a4");
  });
});

describe("SessionItem pause control", () => {
  test("renders a pause button for expanded running sessions", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionItem, {
        active: false,
        compact: false,
        session: makeSession({ status: "running" }),
        onClose: () => {},
        onEdit: () => {},
        onMaximize: () => {},
        onNew: () => {},
        onPauseToggle: () => {},
        onSelect: () => {}
      })
    );

    expect(markup).toContain('title="Pause session"');
    expect(markup).toContain('aria-label="Pause session"');
  });

  test("renders a resume button for expanded paused sessions", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionItem, {
        active: false,
        compact: false,
        session: makeSession({ status: "paused" }),
        onClose: () => {},
        onEdit: () => {},
        onMaximize: () => {},
        onNew: () => {},
        onPauseToggle: () => {},
        onSelect: () => {}
      })
    );

    expect(markup).toContain('title="Resume session"');
    expect(markup).toContain('aria-label="Resume session"');
  });

  test("omits the pause control in compact mode", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionItem, {
        active: false,
        compact: true,
        session: makeSession({ status: "running" }),
        onClose: () => {},
        onEdit: () => {},
        onMaximize: () => {},
        onNew: () => {},
        onPauseToggle: () => {},
        onSelect: () => {}
      })
    );

    expect(markup).not.toContain("Pause session");
    expect(markup).not.toContain("Resume session");
  });
});

describe("SessionItem terminated controls", () => {
  test("omits live-session action buttons for terminal statuses", () => {
    const terminalStatuses: SessionMeta["status"][] = ["completed", "failed", "disconnected"];

    for (const status of terminalStatuses) {
      const markup = renderToStaticMarkup(
        createElement(SessionItem, {
          active: true,
          compact: false,
          session: makeSession({ status }),
          onClose: () => {},
          onEdit: () => {},
          onMaximize: () => {},
          onNew: () => {},
          onPauseToggle: () => {},
          onSelect: () => {},
          viewMode: "fill"
        })
      );

      expect(markup).not.toContain("New session from here");
      expect(markup).not.toContain("Edit session");
      expect(markup).not.toContain("Pause session");
      expect(markup).not.toContain("Resume session");
      expect(markup).not.toContain("Clamp terminal size");
      expect(markup).not.toContain('data-icon="lock-open"');
      expect(markup).not.toContain('data-icon="lock-closed"');
      expect(markup).toContain("Close session");
    }
  });
});

describe("SessionItem open terminal ordering", () => {
  test("renders the Open terminal button above the status/client meta for active sessions", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionItem, {
        active: true,
        compact: false,
        session: makeSession({ clientLabel: "ssh laptop" }),
        onClose: () => {},
        onEdit: () => {},
        onMaximize: () => {},
        onNew: () => {},
        onPauseToggle: () => {},
        onSelect: () => {}
      })
    );

    const buttonIndex = markup.indexOf("Open terminal");
    const metaIndex = markup.indexOf('class="meta"');
    expect(buttonIndex).toBeGreaterThanOrEqual(0);
    expect(metaIndex).toBeGreaterThanOrEqual(0);
    expect(buttonIndex).toBeLessThan(metaIndex);
  });
});

describe("SessionItem clamp lock", () => {
  const lockProps = {
    compact: false,
    onClose: () => {},
    onEdit: () => {},
    onMaximize: () => {},
    onNew: () => {},
    onPauseToggle: () => {},
    onSelect: () => {}
  };

  test("shows a closed lock for the active clamped session", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionItem, {
        ...lockProps,
        active: true,
        session: makeSession(),
        viewMode: "clamped"
      })
    );

    expect(markup).toContain('data-icon="lock-closed"');
    expect(markup).not.toContain('data-icon="lock-open"');
  });

  test("shows an open lock for the active fill session", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionItem, {
        ...lockProps,
        active: true,
        session: makeSession(),
        viewMode: "fill"
      })
    );

    expect(markup).toContain('data-icon="lock-open"');
    expect(markup).not.toContain('data-icon="lock-closed"');
  });

  test("forces a closed lock when locked even if the mode is fill", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionItem, {
        ...lockProps,
        active: true,
        session: makeSession(),
        viewMode: "fill",
        viewModeLocked: true
      })
    );

    expect(markup).toContain('data-icon="lock-closed"');
    expect(markup).not.toContain('data-icon="lock-open"');
    expect(markup).not.toContain('data-disabled="true"');
  });

  test("keeps the lock enabled for the active session", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionItem, {
        ...lockProps,
        active: true,
        session: makeSession(),
        viewMode: "clamped"
      })
    );

    expect(markup).not.toContain('data-disabled="true"');
  });

  test("renders the lock for inactive live sessions so hover can reveal it", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionItem, {
        ...lockProps,
        active: false,
        session: makeSession(),
        viewMode: "fill"
      })
    );

    expect(markup).not.toContain('data-icon="lock-closed"');
    expect(markup).toContain('data-icon="lock-open"');
  });

  test("reveals the lock on hover like the other actions, but keeps it visible on mobile", () => {
    const source = readFileSync("src/web/components/SessionItem.tsx", "utf8");

    expect(source).toContain('":hover .climon-lock": { display: "inline-flex" }');
    expect(source).toContain('mergeClasses("climon-lock", styles.lockBtn)');
    expect(source).toMatch(
      /lockBtn:\s*\{[\s\S]*?display:\s*"none"[\s\S]*?\[MOBILE_MEDIA_QUERY_RULE\][\s\S]*?display:\s*"inline-flex"/
    );
  });
});
