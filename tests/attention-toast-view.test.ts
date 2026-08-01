import { afterAll, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as RealComponents from "@fluentui/react-components";
import * as RealIcons from "@fluentui/react-icons";
import type { AttentionToast } from "../src/web/attentionToast.js";

const realComponents = { ...RealComponents };
const realIcons = { ...RealIcons };

afterAll(() => {
  mock.module("@fluentui/react-components", () => realComponents);
  mock.module("@fluentui/react-icons", () => realIcons);
});

type MockProps = {
  children?: ReactNode;
  action?: ReactNode;
  title?: string;
  "aria-label"?: string;
  icon?: ReactNode;
  appearance?: string;
  size?: string;
  style?: Record<string, unknown>;
  onClick?: (event: { stopPropagation: () => void }) => void;
};

mock.module("@fluentui/react-components", () => ({
  Button: ({ children, title, "aria-label": ariaLabel, icon, onClick }: MockProps) =>
    createElement("button", { title, "aria-label": ariaLabel, onClick }, icon, children),
  Toast: ({ children, onClick, style }: MockProps) => createElement("div", { onClick, style }, children),
  ToastBody: ({ children }: MockProps) => createElement("div", { "data-slot": "body" }, children),
  ToastTitle: ({ children, action }: MockProps) => createElement("div", { "data-slot": "title" }, children, action)
}));

mock.module("@fluentui/react-icons", () => ({
  Dismiss20Regular: () => createElement("span", { "data-icon": "dismiss" })
}));

const {
  AttentionToastView,
  dismissAttentionToast,
  openAttentionToast
} = await import("../src/web/components/AttentionToastView.js");

function toast(overrides: Partial<AttentionToast> = {}): AttentionToast {
  return {
    toastId: "toast-1",
    message: "API server needs attention",
    body: "Saved. Run tests?",
    sessionId: "session-1",
    ...overrides
  };
}

describe("AttentionToastView", () => {
  test("renders the dismiss control with the expected accessible label and title", () => {
    const markup = renderToStaticMarkup(
      createElement(AttentionToastView, {
        toast: toast(),
        onOpen: () => {},
        onDismiss: () => {}
      })
    );

    expect(markup).toContain('aria-label="Dismiss notification"');
    expect(markup).toContain('title="Dismiss notification"');
    expect(markup).toContain("API server needs attention");
    expect(markup).toContain("Saved. Run tests?");
  });

  test("dismissAttentionToast stops propagation and dismisses only the toast", () => {
    let stopped = 0;
    const dismissed: string[] = [];

    dismissAttentionToast(
      { stopPropagation: () => { stopped++; } },
      "toast-1",
      (toastId) => {
        dismissed.push(toastId);
      }
    );

    expect(stopped).toBe(1);
    expect(dismissed).toEqual(["toast-1"]);
  });

  test("openAttentionToast opens the session and then dismisses the toast", () => {
    const opened: string[] = [];
    const dismissed: string[] = [];
    const toastModel = toast();

    openAttentionToast(
      toastModel,
      (sessionId) => {
        opened.push(sessionId);
      },
      (toastId) => {
        dismissed.push(toastId);
      }
    );

    expect(opened).toEqual(["session-1"]);
    expect(dismissed).toEqual(["toast-1"]);
  });
});
