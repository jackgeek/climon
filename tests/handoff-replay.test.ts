import { describe, expect, test } from "bun:test";
import xterm from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import {
  createHandoffReplayCheckpoint,
  shouldRestoreHandoffReplayCheckpoint
} from "../src/web/handoff-replay.js";

const { Terminal } = xterm;

const WINDOWS_RESIZE_ERASE_ONLY = `\x1b[?25l${"\x1b[K\r\n".repeat(55)}\x1b[K\x1b[H\x1b[?25h`;

function writeTerminal(term: InstanceType<typeof Terminal>, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function terminalText(term: InstanceType<typeof Terminal>): string {
  const lines = Array.from({ length: term.rows }, (_, index) =>
    term.buffer.active.getLine(term.buffer.active.baseY + index)?.translateToString(true) ?? ""
  );
  return lines.join("\n");
}

describe("browser handoff replay checkpoint", () => {
  test("restores full styled scrollback after the Windows erase-only resize repaint", async () => {
    const term = new Terminal({ cols: 20, rows: 4, scrollback: 100, allowProposedApi: true });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    await writeTerminal(term, "\x1b[31mold1\x1b[0m\r\nold2\r\nold3\r\nold4\r\nold5");
    const checkpoint = createHandoffReplayCheckpoint(
      7,
      serializer.serialize(),
      terminalText(term),
      term.cols,
      term.rows
    );

    term.resize(30, 6);
    const targetSize = { cols: term.cols, rows: term.rows };
    await writeTerminal(term, WINDOWS_RESIZE_ERASE_ONLY);
    expect(terminalText(term).trim()).toBe("");
    expect(
      shouldRestoreHandoffReplayCheckpoint({
        checkpoint,
        currentAttachmentGeneration: 7,
        replayRequested: true,
        currentText: terminalText(term)
      })
    ).toBe(true);

    term.resize(checkpoint.cols, checkpoint.rows);
    term.reset();
    await writeTerminal(term, checkpoint.serialized);
    term.resize(targetSize.cols, targetSize.rows);

    expect(terminalText(term)).toContain("old1");
    expect(terminalText(term)).toContain("old5");
    expect([term.cols, term.rows]).toEqual([30, 6]);
    expect(checkpoint.serialized).toContain("\x1b[31m");
    term.dispose();
  });

  test("keeps a nonblank post-resize terminal authoritative", () => {
    const checkpoint = createHandoffReplayCheckpoint(2, "serialized", "before", 80, 24);

    expect(
      shouldRestoreHandoffReplayCheckpoint({
        checkpoint,
        currentAttachmentGeneration: 2,
        replayRequested: true,
        currentText: "new authoritative output"
      })
    ).toBe(false);
  });

  test("does not restore a blank checkpoint", () => {
    const checkpoint = createHandoffReplayCheckpoint(2, "serialized", " \r\n\t", 80, 24);

    expect(
      shouldRestoreHandoffReplayCheckpoint({
        checkpoint,
        currentAttachmentGeneration: 2,
        replayRequested: true,
        currentText: ""
      })
    ).toBe(false);
  });

  test("rejects stale generations and non-replay binary frames", () => {
    const checkpoint = createHandoffReplayCheckpoint(2, "serialized", "before", 80, 24);

    expect(
      shouldRestoreHandoffReplayCheckpoint({
        checkpoint,
        currentAttachmentGeneration: 3,
        replayRequested: true,
        currentText: ""
      })
    ).toBe(false);
    expect(
      shouldRestoreHandoffReplayCheckpoint({
        checkpoint,
        currentAttachmentGeneration: 2,
        replayRequested: false,
        currentText: ""
      })
    ).toBe(false);
  });
});
