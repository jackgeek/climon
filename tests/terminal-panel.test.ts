import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { terminalPanelArrowData } from "../src/web/components/TerminalPanel.js";

describe("TerminalPanel", () => {
  test("maps chooser arrow buttons to page key input", () => {
    expect(terminalPanelArrowData("up")).toBe("\x1b[5~");
    expect(terminalPanelArrowData("down")).toBe("\x1b[6~");
  });

  test("wires chooser arrow buttons to page key input", () => {
    const source = readFileSync("src/web/components/TerminalPanel.tsx", "utf8");

    expect(source).toContain('aria-label="Send PageDown"');
    expect(source).toContain('onClick={() => onSend(terminalPanelArrowData("down"))}');
    expect(source).toContain('aria-label="Send PageUp"');
    expect(source).toContain('onClick={() => onSend(terminalPanelArrowData("up"))}');
  });
});
