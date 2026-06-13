import { Buffer } from "node:buffer";

const ALTERNATE_SCREEN_ENTER = "\x1b[?1049h";
const ALTERNATE_SCREEN_CONTROLS = /\x1b\[\?(?:47|1047|1049)([hl])/g;
const MOUSE_TRACKING_PRIVATE_MODES = new Set(["9", "1000", "1002", "1003", "1005", "1006", "1015"]);
const PRIVATE_MODE_CONTROLS = /\x1b\[\?([0-9;]*)([hl])/g;

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

export function stripMouseTrackingControlsFromReplay(data: Uint8Array): Buffer {
  const text = Buffer.from(data).toString("utf8");
  return Buffer.from(
    text.replace(PRIVATE_MODE_CONTROLS, (sequence, rawParams: string, suffix: string) => {
      const params = rawParams.split(";").filter((param) => param.length > 0);
      const retained = params.filter((param) => !MOUSE_TRACKING_PRIVATE_MODES.has(param));
      if (retained.length === params.length) {
        return sequence;
      }
      return retained.length > 0 ? `\x1b[?${retained.join(";")}${suffix}` : "";
    })
  );
}
