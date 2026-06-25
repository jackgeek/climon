import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as RealIcons from "@fluentui/react-icons";
import * as RealComponents from "@fluentui/react-components";
import {
  getStableSessionItemRef,
  keyBarPinnedMenuLabel,
  notificationsMenuLabel,
  remotesMenuLabel,
  scrollActiveSessionIntoView,
  type StableSessionItemRefRegistry
} from "../src/web/sidebar-utils.js";
import { remoteHostsMenuLabel } from "../src/web/components/RemoteHostsPanel.js";

type PassthroughProps = {
  children?: ReactNode;
};

function Passthrough({ children }: PassthroughProps) {
  return createElement("div", null, children);
}

mock.module("@fluentui/react-components", () => ({
  // Spread every real export so unrelated named imports (Input, Field, etc.)
  // resolve; override only the components this suite needs as lightweight stubs.
  ...RealComponents,
  Button: ({ children, title }: PassthroughProps & { title?: string }) =>
    createElement("button", { title }, children),
  Menu: Passthrough,
  MenuDivider: () => createElement("hr", null),
  MenuGroup: Passthrough,
  MenuGroupHeader: Passthrough,
  MenuItem: ({ children }: PassthroughProps) => createElement("div", null, children),
  MenuItemRadio: ({ children }: PassthroughProps) => createElement("div", null, children),
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

// Stub every real icon export so this file's global `mock.module` does not drop
// named exports that other test files import (mock.module persists across the
// whole run, so a partial mock here would break unrelated suites).
mock.module("@fluentui/react-icons", () =>
  Object.fromEntries(Object.keys(RealIcons).map((name) => [name, () => createElement("span", null)]))
);

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

  test("labels the pin key bar action", () => {
    expect(keyBarPinnedMenuLabel(false)).toBe("Pin key bar");
    expect(keyBarPinnedMenuLabel(true)).toBe("Unpin key bar");
  });

  test("shows the pin key bar item only on mobile", () => {
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
      onShowRemoteHosts: () => {},
      notificationsEnabled: false,
      onToggleNotifications: () => {},
      canInstallPwa: false,
      onInstallPwa: () => {},
      tunnelLinkStatus: null,
      onTunnelLink: () => {},
      onCloseTunnelLink: () => {},
      viewMode: "clamped" as const,
      viewModeLocked: false,
      onViewModeToggle: () => {},
      onMaximize: () => {},
      onRemoveDisconnected: () => {},
      keyBarPinned: false,
      onToggleKeyBarPinned: () => {}
    };

    const desktop = renderToStaticMarkup(createElement(Sidebar, { ...commonProps, isMobile: false }));
    const mobile = renderToStaticMarkup(createElement(Sidebar, { ...commonProps, isMobile: true }));

    expect(desktop).not.toContain("Pin key bar");
    expect(mobile).toContain("Pin key bar");
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

  test("hides remotes and remote hosts menu items unless remotes are enabled", () => {
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
      onShowRemoteHosts: () => {},
      notificationsEnabled: false,
      onToggleNotifications: () => {},
      canInstallPwa: false,
      onInstallPwa: () => {},
      tunnelLinkStatus: null,
      onTunnelLink: () => {},
      onCloseTunnelLink: () => {},
      viewMode: "clamped" as const,
      viewModeLocked: false,
      viewModeToggleable: false,
      onViewModeToggle: () => {},
      onMaximize: () => {},
      onRemoveDisconnected: () => {},
      isMobile: false,
      keyBarPinned: false,
      onToggleKeyBarPinned: () => {}
    };

    const disabled = renderToStaticMarkup(createElement(Sidebar, commonProps));
    const enabled = renderToStaticMarkup(createElement(Sidebar, { ...commonProps, showRemotesMenu: true }));

    expect(disabled).not.toContain(remotesMenuLabel);
    expect(enabled).toContain(remotesMenuLabel);
    expect(disabled).not.toContain(remoteHostsMenuLabel);
    expect(enabled).toContain(remoteHostsMenuLabel);
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
      onShowRemoteHosts: () => {},
      notificationsEnabled: false,
      onToggleNotifications: () => {},
      canInstallPwa: false,
      onInstallPwa: () => {},
      tunnelLinkStatus: null,
      onTunnelLink: () => {},
      onCloseTunnelLink: () => {},
      viewMode: "clamped" as const,
      viewModeLocked: false,
      viewModeToggleable: false,
      onViewModeToggle: () => {},
      onMaximize: () => {},
      onRemoveDisconnected: () => {},
      isMobile: false,
      keyBarPinned: false,
      onToggleKeyBarPinned: () => {}
    };

    const html = renderToStaticMarkup(createElement(Sidebar, commonProps));

    expect(html).not.toContain("Clamp size");
    expect(html).not.toContain("Clamp terminal size");
  });
});
