import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  LocalTerminalOutputGate,
  renderTerminalWarning
} from "../src/client/connect.js";
import type { TerminalWarningPayload } from "../src/ipc/frame.js";

describe("local terminal overgrown warning", () => {
  test("explains that the terminal is not clamped and how to restore it", () => {
    const message = renderTerminalWarning(
      {
        kind: "overgrown",
        cols: 140,
        rows: 40,
        hostCols: 80,
        hostRows: 24
      },
      0x1c
    );

    expect(message).toContain("not clamped");
    expect(message).toContain("Ctrl-\\ then c");
    expect(message).toContain("Clamp terminal size");
    expect(message).toContain("stop viewing");
  });

  test("suppresses PTY output while overgrown and resumes after restore", () => {
    const gate = new LocalTerminalOutputGate();
    const overgrown: TerminalWarningPayload = {
      kind: "overgrown",
      cols: 140,
      rows: 40,
      hostCols: 80,
      hostRows: 24
    };

    expect(gate.writePtyOutput(Buffer.from("before"))).toEqual(Buffer.from("before"));
    gate.applyWarning(overgrown);
    expect(gate.writePtyOutput(Buffer.from("hidden"))).toBeNull();
    gate.applyWarning({ kind: "restored" });
    expect(gate.writePtyOutput(Buffer.from("after"))).toEqual(Buffer.from("after"));
  });
});
