import { describe, expect, test } from "bun:test";
import {
  controlChord,
  namedKey,
  sgrMouse,
  type MouseEvent,
  type NamedKey,
} from "../src/drivers/terminal-input.js";

describe("controlChord", () => {
  test("encodes ASCII letters case-insensitively", () => {
    expect(controlChord("c")).toBe("\x03");
    expect(controlChord("C")).toBe("\x03");
    expect(controlChord("z")).toBe("\x1a");
  });

  test("rejects values outside the supported control chord set", () => {
    expect(() => controlChord("")).toThrow("Unsupported control chord");
    expect(() => controlChord("ab")).toThrow("Unsupported control chord");
    expect(() => controlChord("1")).toThrow("Unsupported control chord");
    expect(() => controlChord("é")).toThrow("Unsupported control chord");
    expect(() => controlChord("toString")).toThrow("Unsupported control chord");
  });
});

describe("namedKey", () => {
  test("returns exact sequences for the approved named keys", () => {
    const sequences: Record<NamedKey, string> = {
      ArrowUp: "\x1b[A",
      ArrowDown: "\x1b[B",
      ArrowRight: "\x1b[C",
      ArrowLeft: "\x1b[D",
      Home: "\x1b[H",
      End: "\x1b[F",
      PageUp: "\x1b[5~",
      PageDown: "\x1b[6~",
      Insert: "\x1b[2~",
      Delete: "\x1b[3~",
      Enter: "\r",
      Escape: "\x1b",
      Tab: "\t",
      Backspace: "\x7f",
    };

    for (const [key, sequence] of Object.entries(sequences)) {
      expect(namedKey(key as NamedKey)).toBe(sequence);
    }
  });

  test("rejects unsupported names at runtime", () => {
    expect(() => namedKey("F1" as NamedKey)).toThrow("Unsupported named key");
    expect(() => namedKey("__proto__" as NamedKey)).toThrow("Unsupported named key");
  });
});

describe("sgrMouse", () => {
  test("encodes press, release, wheel, and move events with exact SGR sequences", () => {
    expect(sgrMouse({ kind: "press", button: 0, col: 10, row: 5 })).toBe(
      "\x1b[<0;10;5M"
    );
    expect(sgrMouse({ kind: "release", button: 0, col: 10, row: 5 })).toBe(
      "\x1b[<0;10;5m"
    );
    expect(sgrMouse({ kind: "wheel-up", col: 4, row: 3 })).toBe(
      "\x1b[<64;4;3M"
    );
    expect(
      sgrMouse({
        kind: "move",
        button: 1,
        col: 7,
        row: 8,
        modifiers: { shift: true, alt: true, ctrl: true },
      })
    ).toBe("\x1b[<61;7;8M");
  });

  test("rejects invalid mouse coordinates, buttons, and unsupported kinds", () => {
    expect(() =>
      sgrMouse({ kind: "press", button: 3, col: 1, row: 1 } as unknown as MouseEvent)
    ).toThrow("Unsupported mouse button");
    expect(() =>
      sgrMouse({ kind: "wheel-up", col: 0, row: 1 })
    ).toThrow("Mouse coordinates must be positive integers");
    expect(() =>
      sgrMouse({ kind: "move", button: 0, col: 1.5, row: 1 })
    ).toThrow("Mouse coordinates must be positive integers");
    expect(() =>
      sgrMouse({ kind: "drag" as "press", button: 0, col: 1, row: 1 })
    ).toThrow("Unsupported mouse event");
  });
});
