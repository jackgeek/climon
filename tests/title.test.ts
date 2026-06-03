import { describe, expect, test } from "bun:test";
import { sanitizeTitle, titleSetSequence, titleClearSequence, TitleController } from "../src/client/title.js";

describe("sanitizeTitle", () => {
  test("strips control characters", () => {
    expect(sanitizeTitle("a\x1b]0;evil\x07b\nc")).toBe("a]0;evilbc");
  });

  test("caps length at 256 characters", () => {
    expect(sanitizeTitle("x".repeat(300)).length).toBe(256);
  });

  test("leaves a normal name untouched", () => {
    expect(sanitizeTitle("dev server")).toBe("dev server");
  });
});

describe("OSC sequences", () => {
  test("set wraps the sanitized name in OSC 0", () => {
    expect(titleSetSequence("dev")).toBe("\x1b]0;dev\x07");
  });

  test("clear is an empty OSC 0", () => {
    expect(titleClearSequence()).toBe("\x1b]0;\x07");
  });
});

function fakeOut(isTTY: boolean) {
  const writes: string[] = [];
  return { isTTY, writes, write: (s: string) => { writes.push(s); } };
}

describe("TitleController", () => {
  test("applies a non-empty name and tracks that it set the title", () => {
    const out = fakeOut(true);
    const ctrl = new TitleController(out);
    ctrl.apply("dev");
    expect(out.writes).toEqual(["\x1b]0;dev\x07"]);
  });

  test("clears on an empty name only after a title was set", () => {
    const out = fakeOut(true);
    const ctrl = new TitleController(out);
    ctrl.apply("");
    expect(out.writes).toEqual([]); // nothing set yet, do not clobber the shell title
    ctrl.apply("dev");
    ctrl.apply("");
    expect(out.writes).toEqual(["\x1b]0;dev\x07", "\x1b]0;\x07"]);
  });

  test("clear() clears only if a title was set", () => {
    const out = fakeOut(true);
    const ctrl = new TitleController(out);
    ctrl.clear();
    expect(out.writes).toEqual([]);
    ctrl.apply("dev");
    ctrl.clear();
    expect(out.writes).toEqual(["\x1b]0;dev\x07", "\x1b]0;\x07"]);
  });

  test("is a no-op when output is not a TTY", () => {
    const out = fakeOut(false);
    const ctrl = new TitleController(out);
    ctrl.apply("dev");
    ctrl.clear();
    expect(out.writes).toEqual([]);
  });
});
