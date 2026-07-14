import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BrowserFrameGate } from "../src/server/browser-frame-gate.js";

describe("BrowserFrameGate", () => {
  test("buffers frames that arrive before the daemon is ready and flushes them in order", () => {
    const gate = new BrowserFrameGate();
    const resize = JSON.stringify({ type: "resize", cols: 198, rows: 58 });
    const takeControl = JSON.stringify({ type: "takeControl" });

    expect(gate.buffer(resize)).toBe(true);
    expect(gate.buffer(takeControl)).toBe(true);

    expect(gate.flush()).toEqual([resize, takeControl]);
  });

  test("flush clears the buffer so a second flush yields nothing", () => {
    const gate = new BrowserFrameGate();
    gate.buffer("a");

    expect(gate.flush()).toEqual(["a"]);
    expect(gate.flush()).toEqual([]);
  });

  test("drops frames beyond the cap and reports the drop", () => {
    const gate = new BrowserFrameGate(2);

    expect(gate.buffer("a")).toBe(true);
    expect(gate.buffer("b")).toBe(true);
    expect(gate.buffer("c")).toBe(false);

    expect(gate.flush()).toEqual(["a", "b"]);
  });
});

describe("dashboard server bridge wiring", () => {
  test("routes pre-daemon browser frames through the gate instead of dropping them", () => {
    const source = readFileSync("src/server/server.ts", "utf8");

    // The pre-daemon window must buffer, not silently return.
    expect(source).toContain("BrowserFrameGate");
    expect(source).toContain(".buffer(raw)");
    // Buffered frames must be drained once the daemon socket is wired.
    expect(source).toContain(".flush()");
  });
});
