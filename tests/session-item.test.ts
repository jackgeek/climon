import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionMeta } from "../src/types.js";
import { sessionAccessibleLabel, sessionDisplayTitle } from "../src/web/components/SessionItem.js";

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
    const { SessionItem } = require("../src/web/components/SessionItem.js") as typeof import("../src/web/components/SessionItem.js");
    const markup = renderToStaticMarkup(
      createElement(SessionItem, {
        active: false,
        compact: true,
        session: makeSession({ name: "API server" }),
        onClose: () => {},
        onEdit: () => {},
        onMaximize: () => {},
        onNew: () => {},
        onSelect: () => {}
      })
    );

    expect(markup).toContain('title="API server"');
    expect(markup).not.toContain('title="running"');
  });

  test("uses the normal color accent when inactive", () => {
    const { SessionItem } = require("../src/web/components/SessionItem.js") as typeof import("../src/web/components/SessionItem.js");
    const markup = renderToStaticMarkup(
      createElement(SessionItem, {
        active: false,
        compact: true,
        session: makeSession({ color: "blue", name: "API server" }),
        onClose: () => {},
        onEdit: () => {},
        onMaximize: () => {},
        onNew: () => {},
        onSelect: () => {}
      })
    );

    expect(markup).toContain("border-right:4px solid #3465a4");
    expect(markup).not.toContain("#729fcf");
  });

  test("uses the highlighted color accent when active", () => {
    const { SessionItem } = require("../src/web/components/SessionItem.js") as typeof import("../src/web/components/SessionItem.js");
    const markup = renderToStaticMarkup(
      createElement(SessionItem, {
        active: true,
        compact: true,
        session: makeSession({ color: "blue", name: "API server" }),
        onClose: () => {},
        onEdit: () => {},
        onMaximize: () => {},
        onNew: () => {},
        onSelect: () => {}
      })
    );

    expect(markup).toContain("border-right:4px solid #729fcf");
    expect(markup).not.toContain("#3465a4");
  });
});
