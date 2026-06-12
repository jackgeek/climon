import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getStableSessionItemRef,
  notificationsMenuLabel,
  remotesMenuLabel,
  scrollActiveSessionIntoView,
  type StableSessionItemRefRegistry
} from "../src/web/sidebar-utils.js";

type PassthroughProps = {
  children?: ReactNode;
};

function Passthrough({ children }: PassthroughProps) {
  return createElement("div", null, children);
}

mock.module("@fluentui/react-components", () => ({
  Button: ({ children, title }: PassthroughProps & { title?: string }) =>
    createElement("button", { title }, children),
  Menu: Passthrough,
  MenuItem: ({ children }: PassthroughProps) => createElement("div", null, children),
  MenuList: Passthrough,
  MenuPopover: Passthrough,
  MenuTrigger: Passthrough,
  Text: Passthrough,
  makeStyles: () => () => ({
    actions: "actions",
    collapsedEmpty: "collapsedEmpty",
    collapsedFooter: "collapsedFooter",
    collapsedHeader: "collapsedHeader",
    collapsedRoot: "collapsedRoot",
    empty: "empty",
    footer: "footer",
    header: "header",
    hiddenTitle: "hiddenTitle",
    list: "list",
    listItem: "listItem",
    root: "root",
    title: "title",
    version: "version"
  }),
  mergeClasses: (...classes: Array<string | false | undefined>) => classes.filter(Boolean).join(" "),
  tokens: {
    colorNeutralForeground3: "#666",
    colorNeutralStroke1: "#ddd",
    fontWeightRegular: 400,
    fontWeightSemibold: 600
  }
}));

mock.module("@fluentui/react-icons", () => ({
  Add20Regular: () => createElement("span", null),
  ChevronDoubleLeftRegular: () => createElement("span", null),
  ChevronDoubleRightRegular: () => createElement("span", null),
  Navigation20Regular: () => createElement("span", null)
}));

mock.module("../src/web/components/SessionItem.js", () => ({
  SessionItem: () => createElement("div", null)
}));

mock.module("../src/web/hooks/useAnimatedListReorder.js", () => ({
  useAnimatedListReorder: () => ({
    getItemStyle: () => ({}),
    registerItem: () => () => {}
  })
}));

const { Sidebar } = await import("../src/web/components/Sidebar.js");

describe("Sidebar menu", () => {
  test("labels the remotes action", () => {
    expect(remotesMenuLabel).toBe("Remotes");
  });

  test("labels the notification permission action", () => {
    expect(notificationsMenuLabel(false)).toBe("Enable notifications");
    expect(notificationsMenuLabel(true)).toBe("Disable notifications");
  });

  test("keeps the session list as the scrollable sidebar region", () => {
    const source = readFileSync("src/web/components/Sidebar.tsx", "utf8");

    expect(source).toContain('overflowY: "auto"');
    expect(source).toContain("minHeight: 0");
    expect(source).not.toContain("scrollbarGutter");
  });

  test("places the session list scrollbar on the left without reversing item content", () => {
    const source = readFileSync("src/web/components/Sidebar.tsx", "utf8");

    expect(source).toContain('dir="rtl"');
    expect(source).toContain('dir="ltr"');
    expect(source).toContain('direction: "rtl"');
    expect(source).toContain('direction: "ltr"');
  });

  test("scrolls the active session into view without jumping the whole list", () => {
    const calls: ScrollIntoViewOptions[] = [];
    const active = {
      scrollIntoView: (options?: boolean | ScrollIntoViewOptions) => calls.push(options as ScrollIntoViewOptions)
    };

    scrollActiveSessionIntoView("s2", (id) => (id === "s2" ? active : null));

    expect(calls).toEqual([{ block: "nearest" }]);
  });

  test("keeps session item refs stable while forwarding to the latest animation ref", () => {
    const registry: StableSessionItemRefRegistry = { refs: {}, animatedRefs: {}, elements: {} };
    const firstCalls: unknown[] = [];
    const secondCalls: unknown[] = [];
    const element = { id: "node" } as unknown as HTMLElement;

    const firstRef = getStableSessionItemRef(registry, "s1", () => (node) => firstCalls.push(node));
    const secondRef = getStableSessionItemRef(registry, "s1", () => (node) => secondCalls.push(node));

    expect(secondRef).toBe(firstRef);

    secondRef(element);

    expect(firstCalls).toEqual([]);
    expect(secondCalls).toEqual([element]);
    expect(registry.elements.s1).toBe(element);
  });

  test("hides remotes menu item unless remotes are enabled", () => {
    const commonProps = {
      sessions: [],
      activeId: null,
      collapsed: false,
      collapsible: true,
      onCollapsedChange: () => {},
      onSelect: () => {},
      onClose: () => {},
      onNew: () => {},
      onNewFrom: () => {},
      onEdit: () => {},
      onPauseToggle: () => {},
      onManageRemote: () => {},
      notificationsEnabled: false,
      onToggleNotifications: () => {},
      tunnelLinkStatus: null,
      onTunnelLink: () => {},
      onCloseTunnelLink: () => {},
      viewMode: "clamped" as const,
      viewModeLocked: false,
      viewModeToggleable: false,
      onViewModeToggle: () => {},
      onMaximize: () => {},
      onRemoveDisconnected: () => {}
    };

    const disabled = renderToStaticMarkup(createElement(Sidebar, commonProps));
    const enabled = renderToStaticMarkup(createElement(Sidebar, { ...commonProps, showRemotesMenu: true }));

    expect(disabled).not.toContain(remotesMenuLabel);
    expect(enabled).toContain(remotesMenuLabel);
  });

  test("no longer shows the clamp terminal size item in the hamburger menu", () => {
    const commonProps = {
      sessions: [],
      activeId: null,
      collapsed: false,
      collapsible: true,
      onCollapsedChange: () => {},
      onSelect: () => {},
      onClose: () => {},
      onNew: () => {},
      onNewFrom: () => {},
      onEdit: () => {},
      onPauseToggle: () => {},
      onManageRemote: () => {},
      notificationsEnabled: false,
      onToggleNotifications: () => {},
      tunnelLinkStatus: null,
      onTunnelLink: () => {},
      onCloseTunnelLink: () => {},
      viewMode: "clamped" as const,
      viewModeLocked: false,
      viewModeToggleable: false,
      onViewModeToggle: () => {},
      onMaximize: () => {},
      onRemoveDisconnected: () => {}
    };

    const html = renderToStaticMarkup(createElement(Sidebar, commonProps));

    expect(html).not.toContain("Clamp size");
    expect(html).not.toContain("Clamp terminal size");
  });

  test("shows the bug report mail link only when expanded", () => {
    const commonProps = {
      sessions: [],
      activeId: null,
      collapsible: true,
      onCollapsedChange: () => {},
      onSelect: () => {},
      onClose: () => {},
      onNew: () => {},
      onNewFrom: () => {},
      onEdit: () => {},
      onPauseToggle: () => {},
      onManageRemote: () => {},
      notificationsEnabled: false,
      onToggleNotifications: () => {},
      tunnelLinkStatus: null,
      onTunnelLink: () => {},
      onCloseTunnelLink: () => {},
      viewMode: "clamped" as const,
      viewModeLocked: false,
      viewModeToggleable: false,
      onViewModeToggle: () => {},
      onMaximize: () => {},
      onRemoveDisconnected: () => {}
    };

    const expanded = renderToStaticMarkup(createElement(Sidebar, { ...commonProps, collapsed: false }));
    const collapsed = renderToStaticMarkup(createElement(Sidebar, { ...commonProps, collapsed: true }));

    expect(expanded).toContain('href="mailto://jackallan@microsoft.com"');
    expect(expanded).toContain("File a bug");
    expect(collapsed).not.toContain('href="mailto://jackallan@microsoft.com"');
    expect(collapsed).not.toContain("File a bug");
  });
});
