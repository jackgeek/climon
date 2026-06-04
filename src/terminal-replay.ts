import { Buffer } from "node:buffer";

const ALTERNATE_SCREEN_ENTER = "\x1b[?1049h";
const ALTERNATE_SCREEN_CONTROLS = /\x1b\[\?(?:47|1047|1049)([hl])/g;

export function sanitizeBrowserTerminalReplay(data: Uint8Array): Buffer {
  const buffer = Buffer.from(data);
  const text = buffer.toString("utf8");
  let firstAlternateControl: "h" | "l" | undefined;
  ALTERNATE_SCREEN_CONTROLS.lastIndex = 0;
  const match = ALTERNATE_SCREEN_CONTROLS.exec(text);
  if (match?.[1] === "h" || match?.[1] === "l") {
    firstAlternateControl = match[1];
  }
  if (firstAlternateControl !== "l") {
    return buffer;
  }
  return Buffer.concat([Buffer.from(ALTERNATE_SCREEN_ENTER), buffer]);
}
