/**
 * ⚠️ LEGACY TypeScript client — frozen. Fix the Rust client instead.
 *
 * The shipping `climon` *client* is the Rust workspace under `rust/` (crates
 * `climon-cli`, `climon-session`, `climon-pty`, `climon-store`, `climon-config`,
 * `climon-remote`, `climon-install`, `climon-update`, …). This module belongs to
 * the legacy Bun/TypeScript client, kept only for local development and the Bun
 * test suite. Do NOT add features or fix client bugs here — make all client
 * changes in the Rust crates. (The Bun dashboard *server* under `src/server*`
 * and `src/web/` is NOT legacy and is still maintained.)
 */
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
