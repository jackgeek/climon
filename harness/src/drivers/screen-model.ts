import xtermHeadless from "@xterm/headless";
import { HarnessError } from "../types.js";

type HeadlessTerminal = import("@xterm/headless").Terminal;

const { Terminal } = xtermHeadless as {
  Terminal: new (...args: ConstructorParameters<typeof import("@xterm/headless").Terminal>) => HeadlessTerminal;
};

export interface ScreenCursor {
  col: number;
  row: number;
}

function assertPositiveInteger(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new HarnessError(
      "prerequisite",
      "Screen dimensions must be positive integers"
    );
  }
}

export class ScreenModel {
  private readonly terminal: HeadlessTerminal;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(cols: number, rows: number) {
    assertPositiveInteger(cols);
    assertPositiveInteger(rows);
    this.terminal = new Terminal({ cols, rows, allowProposedApi: true });
  }

  public write(data: string | Uint8Array): Promise<void> {
    this.writeQueue = this.writeQueue.then(
      () =>
        new Promise<void>((resolve) => {
          this.terminal.write(data, resolve);
        })
    );

    return this.writeQueue;
  }

  public resize(cols: number, rows: number): void {
    assertPositiveInteger(cols);
    assertPositiveInteger(rows);
    this.terminal.resize(cols, rows);
  }

  public contents(): string {
    const active = this.terminal.buffer.active;
    const lines: string[] = [];
    const start =
      active.type === "alternate" ? 0 : Math.min(active.viewportY, active.baseY);
    const end = start + this.terminal.rows;

    for (let index = start; index < end; index += 1) {
      const line = active.getLine(index);

      if (!line) {
        lines.push("");
        continue;
      }

      let lastOccupied = -1;

      for (let column = this.terminal.cols - 1; column >= 0; column -= 1) {
        const cell = line.getCell(column);
        if (cell?.getChars() !== "") {
          lastOccupied = column;
          break;
        }
      }

      lines.push(
        lastOccupied >= 0
          ? line.translateToString(false, 0, lastOccupied + 1)
          : ""
      );
    }

    while (lines.length > 0 && lines.at(-1) === "") {
      lines.pop();
    }

    return lines.join("\n");
  }

  public cursor(): ScreenCursor {
    const active = this.terminal.buffer.active;
    return {
      col: active.cursorX,
      row: active.cursorY,
    };
  }

  public dispose(): void {
    this.terminal.dispose();
  }

  public close(): void {
    this.dispose();
  }
}
