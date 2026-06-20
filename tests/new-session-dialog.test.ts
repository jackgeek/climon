import { describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type PassthroughProps = {
  children?: ReactNode;
};

function Passthrough({ children }: PassthroughProps) {
  return createElement("div", null, children);
}

mock.module("@fluentui/react-components", () => ({
  Button: ({ children }: PassthroughProps) => createElement("button", null, children),
  Checkbox: (props: { label?: string }) => createElement("label", null, props.label),
  Dialog: Passthrough,
  DialogActions: Passthrough,
  DialogBody: Passthrough,
  DialogContent: Passthrough,
  DialogSurface: Passthrough,
  DialogTitle: Passthrough,
  Field: ({ children, label }: PassthroughProps & { label?: string }) =>
    createElement("label", null, label, children),
  Input: (props: { value?: string; readOnly?: boolean; placeholder?: string; onChange?: () => void }) =>
    createElement("input", {
      value: props.value,
      readOnly: props.readOnly,
      placeholder: props.placeholder,
      onChange: props.onChange
    }),
  Text: Passthrough,
  makeStyles: () => () => ({ error: "error" }),
  tokens: {
    colorPaletteRedForeground1: "#cc0000"
  }
}));

mock.module("../src/web/components/SessionMetaFields.js", () => ({
  SessionMetaFields: () => createElement("div", { "data-testid": "session-meta-fields" })
}));

const { buildCreateSessionBody, NewSessionDialog } = await import("../src/web/components/NewSessionDialog.js");

describe("NewSessionDialog", () => {
  test("allows editing the inherited working directory before creating a child session", () => {
    const markup = renderToStaticMarkup(
      createElement(NewSessionDialog, {
        open: true,
        onOpenChange: () => {},
        getDimensions: () => ({ cols: 80, rows: 24 }),
        onCreated: () => {},
        parent: { id: "parent-1", cwd: "/repo", priority: 500, color: "blue" }
      })
    );

    expect(markup).toContain("Working directory");
    expect(markup).not.toContain("readOnly");
  });

  test("submits the edited working directory when creating a child session", () => {
    expect(buildCreateSessionBody({
      command: "bash",
      cwd: "/tmp/child",
      cols: 120,
      rows: 30,
      parentId: "parent-1",
      name: "",
      priority: 500,
      color: "blue"
    })).toEqual({
      command: "bash",
      cwd: "/tmp/child",
      cols: 120,
      rows: 30,
      parentId: "parent-1",
      priority: 500,
      color: "blue"
    });
  });

  test("includes headless flag", () => {
    expect(buildCreateSessionBody({
      command: "bash", cwd: "", name: "", priority: 500, color: "auto", headless: true
    }).headless).toBe(true);
  });

  test("defaults headless to false", () => {
    expect(buildCreateSessionBody({
      command: "bash", cwd: "", name: "", priority: 500, color: "auto", headless: false
    }).headless).toBe(false);
  });
});
