import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  getStableSessionItemRef,
  notificationsMenuLabel,
  remotesMenuLabel,
  scrollActiveSessionIntoView,
  type StableSessionItemRefRegistry
} from "../src/web/sidebar-utils.js";

describe("Sidebar menu", () => {
  test("labels remotes as experimental", () => {
    expect(remotesMenuLabel).toBe("Remotes (experimental)…");
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
});
