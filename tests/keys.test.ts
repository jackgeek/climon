import { describe, expect, test } from "bun:test";
import { encodeChar, encodeSpecial } from "../src/web/keys.js";

const NONE = { ctrl: false, alt: false, shift: false };

describe("encodeChar", () => {
  test("plain char returns the char", () => {
    expect(encodeChar("a", NONE)).toBe("a");
  });

  test("ctrl+c sends 0x03", () => {
    expect(encodeChar("c", { ctrl: true, alt: false, shift: false })).toBe("\x03");
  });

  test("ctrl is case-insensitive (C -> 0x03)", () => {
    expect(encodeChar("C", { ctrl: true, alt: false, shift: false })).toBe("\x03");
  });

  test("ctrl+d sends 0x04", () => {
    expect(encodeChar("d", { ctrl: true, alt: false, shift: false })).toBe("\x04");
  });

  test("alt+a prefixes ESC", () => {
    expect(encodeChar("a", { ctrl: false, alt: true, shift: false })).toBe("\x1ba");
  });

  test("shift uppercases the letter", () => {
    expect(encodeChar("a", { ctrl: false, alt: false, shift: true })).toBe("A");
  });

  test("alt+shift+a -> ESC + A", () => {
    expect(encodeChar("a", { ctrl: false, alt: true, shift: true })).toBe("\x1bA");
  });

  test("empty char returns empty string", () => {
    expect(encodeChar("", { ctrl: true, alt: false, shift: false })).toBe("");
  });
});

describe("encodeSpecial", () => {
  test("Esc", () => {
    expect(encodeSpecial("Esc", NONE)).toBe("\x1b");
  });

  test("Tab plain", () => {
    expect(encodeSpecial("Tab", NONE)).toBe("\t");
  });

  test("Enter", () => {
    expect(encodeSpecial("Enter", NONE)).toBe("\r");
  });

  test("Shift+Tab is back-tab", () => {
    expect(encodeSpecial("Tab", { ctrl: false, alt: false, shift: true })).toBe("\x1b[Z");
  });

  test("plain Up arrow", () => {
    expect(encodeSpecial("Up", NONE)).toBe("\x1b[A");
  });

  test("Ctrl+Right -> word jump", () => {
    expect(encodeSpecial("Right", { ctrl: true, alt: false, shift: false })).toBe("\x1b[1;5C");
  });

  test("Shift+Left", () => {
    expect(encodeSpecial("Left", { ctrl: false, alt: false, shift: true })).toBe("\x1b[1;2D");
  });

  test("plain Home", () => {
    expect(encodeSpecial("Home", NONE)).toBe("\x1b[H");
  });

  test("Ctrl+Home", () => {
    expect(encodeSpecial("Home", { ctrl: true, alt: false, shift: false })).toBe("\x1b[1;5H");
  });

  test("plain Delete", () => {
    expect(encodeSpecial("Delete", NONE)).toBe("\x1b[3~");
  });

  test("PageUp / PageDown", () => {
    expect(encodeSpecial("PageUp", NONE)).toBe("\x1b[5~");
    expect(encodeSpecial("PageDown", NONE)).toBe("\x1b[6~");
  });

  test("plain F5", () => {
    expect(encodeSpecial("F5", NONE)).toBe("\x1b[15~");
  });

  test("Shift+F5", () => {
    expect(encodeSpecial("F5", { ctrl: false, alt: false, shift: true })).toBe("\x1b[15;2~");
  });

  test("plain F1", () => {
    expect(encodeSpecial("F1", NONE)).toBe("\x1bOP");
  });

  test("Alt-only Up uses ESC prefix form", () => {
    expect(encodeSpecial("Up", { ctrl: false, alt: true, shift: false })).toBe("\x1b\x1b[A");
  });
});
