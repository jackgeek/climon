import { afterAll, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as RealComponents from "@fluentui/react-components";
import type { SessionMeta } from "../src/types.js";

// `mock.module` is global and mutates the module in place for the whole test
// run, so snapshot the real Fluent exports *before* mocking and restore them
// once this file's tests finish; otherwise suites that render real Fluent
// components afterward (e.g. terminal-panel, app-layout) get the stubs.
const realComponents = { ...RealComponents };
afterAll(() => {
  mock.module("@fluentui/react-components", () => realComponents);
});

let lastMetaFieldsProps: { includeAuto?: boolean } | null = null;

type PassthroughProps = {
  children?: ReactNode;
};

type ButtonProps = PassthroughProps & Record<string, unknown>;

function Passthrough({ children }: PassthroughProps) {
  return createElement("div", null, children);
}

mock.module("@fluentui/react-components", () => ({
  Badge: ({ children, ...props }: ButtonProps) => createElement("div", props, children),
  Button: ({ children, ...props }: ButtonProps) => createElement("button", props, children),
  Dialog: Passthrough,
  DialogActions: Passthrough,
  DialogBody: Passthrough,
  DialogContent: Passthrough,
  DialogSurface: Passthrough,
  DialogTitle: Passthrough,
  Text: Passthrough,
  makeStyles: () => () => ({ error: "error" }),
  mergeClasses: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" "),
  tokens: {
    colorPaletteRedForeground1: "#cc0000"
  }
}));

mock.module("../src/web/components/SessionMetaFields.js", () => ({
  SessionMetaFields: (props: { includeAuto?: boolean }) => {
    lastMetaFieldsProps = props;
    return createElement("div", { "data-testid": "session-meta-fields" });
  }
}));

const { EditSessionDialog } = await import("../src/web/components/EditSessionDialog.js");

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

describe("EditSessionDialog", () => {
  test("uses the shared auto color option", () => {
    lastMetaFieldsProps = null;

    renderToStaticMarkup(createElement(EditSessionDialog, { session: makeSession(), onClose: () => {} }));

    expect(lastMetaFieldsProps).toMatchObject({
      includeAuto: true
    });
  });
});
