import { describe, expect, test } from "bun:test";
import { parseShortcut, matchesShortcut, type ParsedShortcut } from "../src/hotkeys.js";

describe("parseShortcut", () => {
  test("parses a single modifier + key", () => {
    expect(parseShortcut("Alt+T")).toEqual({
      ctrl: false,
      alt: true,
      shift: false,
      meta: false,
      key: "t"
    });
  });

  test("parses multiple modifiers, case-insensitively", () => {
    expect(parseShortcut("ctrl+SHIFT+j")).toEqual({
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
      key: "j"
    });
  });

  test("accepts Control/Cmd/Command aliases", () => {
    expect(parseShortcut("Control+Cmd+K")?.ctrl).toBe(true);
    expect(parseShortcut("Control+Cmd+K")?.meta).toBe(true);
    expect(parseShortcut("Command+L")?.meta).toBe(true);
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseShortcut("  Alt + T ")).toEqual({
      ctrl: false,
      alt: true,
      shift: false,
      meta: false,
      key: "t"
    });
  });

  test("returns null for empty input", () => {
    expect(parseShortcut("")).toBeNull();
    expect(parseShortcut("   ")).toBeNull();
  });

  test("returns null when there is no non-modifier key", () => {
    expect(parseShortcut("Alt+Ctrl")).toBeNull();
  });

  test("returns null for an unknown token", () => {
    expect(parseShortcut("Hyper+T")).toBeNull();
  });

  test("returns null when more than one non-modifier key is given", () => {
    expect(parseShortcut("Alt+T+J")).toBeNull();
  });
});

describe("matchesShortcut", () => {
  const altT: ParsedShortcut = { ctrl: false, alt: true, shift: false, meta: false, key: "t" };

  test("matches an event with the exact modifiers and key", () => {
    expect(
      matchesShortcut({ ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, key: "t" }, altT)
    ).toBe(true);
  });

  test("matches regardless of event key case", () => {
    expect(
      matchesShortcut({ ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, key: "T" }, altT)
    ).toBe(true);
  });

  test("does not match when an extra modifier is held", () => {
    expect(
      matchesShortcut({ ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, key: "t" }, altT)
    ).toBe(false);
  });

  test("does not match a different key", () => {
    expect(
      matchesShortcut({ ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, key: "j" }, altT)
    ).toBe(false);
  });
});
