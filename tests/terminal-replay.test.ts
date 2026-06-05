import { describe, expect, test } from "bun:test";
import xterm from "@xterm/headless";
import { sanitizeBrowserTerminalReplay } from "../src/terminal-replay.js";

const { Terminal } = xterm;

function writeTerminal(term: InstanceType<typeof Terminal>, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function normalHistory(term: InstanceType<typeof Terminal>): Array<string | undefined> {
  return Array.from({ length: term.buffer.active.length }, (_, index) =>
    term.buffer.active.getLine(index)?.translateToString(true)
  );
}

describe("sanitizeBrowserTerminalReplay", () => {
  test("keeps trimmed alternate-screen replay out of normal scrollback", async () => {
    const term = new Terminal({ cols: 20, rows: 3, scrollback: 100, allowProposedApi: true });

    await writeTerminal(term, sanitizeBrowserTerminalReplay(Buffer.from("alt1\r\nalt2\r\n\x1b[?1049l")));

    expect(normalHistory(term)).not.toContain("alt1");
    expect(normalHistory(term)).not.toContain("alt2");
  });
});
