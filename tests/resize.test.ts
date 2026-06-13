import { describe, expect, test } from "bun:test";
import {
  buildMousePrivateModeReplaySuffix,
  clampResize,
  revertSize,
  trackMousePrivateModesFromOutput
} from "../src/daemon/daemon.js";

const host = { cols: 80, rows: 24 };

describe("clampResize", () => {
  test("caps a larger browser viewport to the host terminal size", () => {
    expect(clampResize({ cols: 200, rows: 50, source: "viewer" }, host, true)).toEqual({ cols: 80, rows: 24 });
  });

  test("leaves a smaller browser viewport untouched", () => {
    expect(clampResize({ cols: 60, rows: 20, source: "viewer" }, host, true)).toEqual({ cols: 60, rows: 20 });
  });

  test("never clamps the host terminal itself", () => {
    expect(clampResize({ cols: 200, rows: 50, source: "host" }, host, true)).toEqual({ cols: 200, rows: 50 });
  });

  test("passes the browser viewport through when clamping is disabled", () => {
    expect(clampResize({ cols: 200, rows: 50, source: "viewer" }, host, false)).toEqual({ cols: 200, rows: 50 });
  });

  test("passes a fill-mode browser viewport through even when clamping is enabled", () => {
    expect(clampResize({ cols: 200, rows: 50, source: "viewer", mode: "fill" }, host, true)).toEqual({
      cols: 200,
      rows: 50
    });
  });

  test("clamps a clamped-mode browser viewport when clamping is enabled", () => {
    expect(clampResize({ cols: 200, rows: 50, source: "viewer", mode: "clamped" }, host, true)).toEqual({
      cols: 80,
      rows: 24
    });
  });

  test("treats a missing source as a viewer", () => {
    expect(clampResize({ cols: 200, rows: 50 }, host, true)).toEqual({ cols: 80, rows: 24 });
  });

  test("floors dimensions at 1x1", () => {
    expect(clampResize({ cols: 0, rows: -5, source: "host" }, host, true)).toEqual({ cols: 1, rows: 1 });
  });
});

describe("revertSize", () => {
  test("returns the host size when the applied size differs", () => {
    expect(revertSize({ cols: 80, rows: 24 }, { cols: 40, rows: 12 })).toEqual({ cols: 80, rows: 24 });
  });

  test("returns null when applied already matches host", () => {
    expect(revertSize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBeNull();
  });

  test("floors the host dimensions at 1x1", () => {
    expect(revertSize({ cols: 0, rows: -3 }, { cols: 40, rows: 12 })).toEqual({ cols: 1, rows: 1 });
  });
});

describe("mouse private mode replay tracking", () => {
  test("tracks private mouse modes across split output chunks", () => {
    const state = new Map<string, boolean>();
    const remainder = trackMousePrivateModesFromOutput(state, "\x1b[?10");
    expect(remainder).toBe("\x1b[?10");
    const nextRemainder = trackMousePrivateModesFromOutput(state, "00h", remainder);
    expect(nextRemainder).toBe("");
    expect(state.get("1000")).toBe(true);
  });

  test("tracks mixed enable/disable controls and keeps the latest state", () => {
    const state = new Map<string, boolean>();
    const remainder = trackMousePrivateModesFromOutput(state, "\x1b[?1000;1006h\x1b[?1000l");
    expect(remainder).toBe("");
    expect(state.get("1000")).toBe(false);
    expect(state.get("1006")).toBe(true);
  });

  test("builds a deterministic replay suffix for enabled mouse modes", () => {
    const state = new Map<string, boolean>([
      ["1000", true],
      ["1006", true],
      ["1002", false]
    ]);
    expect(buildMousePrivateModeReplaySuffix(state).toString()).toBe("\x1b[?1000h\x1b[?1006h");
  });
});
