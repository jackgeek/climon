import { describe, expect, test } from "bun:test";
import {
  decideTerminalClipboardAction,
  isMacPlatform,
  type TerminalClipboardEvent
} from "../src/web/terminalClipboard.js";

function ev(overrides: Partial<TerminalClipboardEvent>): TerminalClipboardEvent {
  return {
    key: "a",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isMac: false,
    hasSelection: false,
    ...overrides
  };
}

describe("decideTerminalClipboardAction", () => {
  test("non clipboard keys are ignored", () => {
    expect(decideTerminalClipboardAction(ev({ key: "a", ctrlKey: true }))).toBeNull();
    expect(decideTerminalClipboardAction(ev({ key: "+", ctrlKey: true }))).toBeNull();
  });

  test("plain c/v without the primary modifier are not clipboard chords", () => {
    expect(decideTerminalClipboardAction(ev({ key: "c" }))).toBeNull();
    expect(decideTerminalClipboardAction(ev({ key: "v" }))).toBeNull();
  });

  describe("macOS (Cmd is the primary modifier)", () => {
    test("Cmd+C copies when text is selected", () => {
      expect(
        decideTerminalClipboardAction(ev({ key: "c", metaKey: true, isMac: true, hasSelection: true }))
      ).toBe("copy");
    });

    test("Cmd+C with no selection passes through", () => {
      expect(
        decideTerminalClipboardAction(ev({ key: "c", metaKey: true, isMac: true, hasSelection: false }))
      ).toBe("passthrough");
    });

    test("Cmd+V pastes", () => {
      expect(decideTerminalClipboardAction(ev({ key: "v", metaKey: true, isMac: true }))).toBe("paste");
    });

    test("Ctrl+C on macOS is not a clipboard chord (stays SIGINT)", () => {
      expect(
        decideTerminalClipboardAction(ev({ key: "c", ctrlKey: true, isMac: true, hasSelection: true }))
      ).toBeNull();
    });
  });

  describe("Windows/Linux (Ctrl is the primary modifier)", () => {
    test("Ctrl+C copies when text is selected", () => {
      expect(
        decideTerminalClipboardAction(ev({ key: "c", ctrlKey: true, hasSelection: true }))
      ).toBe("copy");
    });

    test("Ctrl+C with no selection passes through as SIGINT", () => {
      expect(
        decideTerminalClipboardAction(ev({ key: "c", ctrlKey: true, hasSelection: false }))
      ).toBe("passthrough");
    });

    test("Ctrl+Shift+C copies the selection", () => {
      expect(
        decideTerminalClipboardAction(ev({ key: "c", ctrlKey: true, shiftKey: true, hasSelection: true }))
      ).toBe("copy");
    });

    test("Ctrl+V pastes instead of sending a literal ^V", () => {
      expect(decideTerminalClipboardAction(ev({ key: "v", ctrlKey: true }))).toBe("paste");
    });

    test("Ctrl+Shift+V pastes", () => {
      expect(decideTerminalClipboardAction(ev({ key: "v", ctrlKey: true, shiftKey: true }))).toBe("paste");
    });

    test("Cmd+V on Windows/Linux is not a clipboard chord", () => {
      expect(decideTerminalClipboardAction(ev({ key: "v", metaKey: true }))).toBeNull();
    });
  });

  test("uppercase key (from Shift) is matched case-insensitively", () => {
    expect(
      decideTerminalClipboardAction(ev({ key: "C", ctrlKey: true, shiftKey: true, hasSelection: true }))
    ).toBe("copy");
  });
});

describe("isMacPlatform", () => {
  test("detects Apple platforms via navigator.platform", () => {
    expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
    expect(isMacPlatform({ platform: "iPhone" })).toBe(true);
    expect(isMacPlatform({ platform: "Win32" })).toBe(false);
    expect(isMacPlatform({ platform: "Linux x86_64" })).toBe(false);
  });

  test("falls back to the user agent when platform is empty", () => {
    expect(isMacPlatform({ platform: "", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" })).toBe(true);
    expect(isMacPlatform({ platform: "", userAgent: "Mozilla/5.0 (Windows NT 10.0)" })).toBe(false);
  });
});
