// xterm.js renders its selection to a canvas, not the DOM, so the browser's
// native copy shortcut copies an empty DOM selection instead of the terminal
// text. It also has no built-in keyboard copy, and on Windows/Linux Ctrl+V is
// mapped to a literal ^V that is sent to the PTY instead of pasting. This module
// decides how a key event maps to a clipboard action so the browser terminal
// behaves like a native one (Windows Terminal style).

export type TerminalClipboardAction = "copy" | "paste" | "passthrough";

export interface TerminalClipboardEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isMac: boolean;
  hasSelection: boolean;
}

/**
 * Map a keydown to a clipboard action, or `null` when it is not a clipboard
 * chord (the caller keeps handling other shortcuts, e.g. Ctrl +/- zoom).
 *
 * Behaviour (Windows Terminal style):
 *   - macOS: Cmd+C copies the selection, Cmd+V pastes.
 *   - Windows/Linux: Ctrl+Shift+C / Ctrl+Shift+V copy/paste; additionally plain
 *     Ctrl+C copies when text is selected (otherwise it stays a SIGINT) and plain
 *     Ctrl+V pastes.
 *
 * Actions:
 *   - "copy"        Write the current selection to the clipboard and swallow the
 *                   key so it is not sent to the PTY.
 *   - "paste"       Swallow xterm's own key handling (which would otherwise emit
 *                   a literal ^V) without calling preventDefault, so the browser's
 *                   native paste event still fires and xterm forwards it.
 *   - "passthrough" Let xterm/PTY handle the key normally (e.g. Ctrl+C with no
 *                   selection = SIGINT).
 */
export function decideTerminalClipboardAction(
  event: TerminalClipboardEvent
): TerminalClipboardAction | null {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key !== "c" && key !== "v") {
    return null;
  }
  const primaryModifier = event.isMac ? event.metaKey : event.ctrlKey;
  if (!primaryModifier) {
    return null;
  }
  if (key === "v") {
    return "paste";
  }
  // key === "c": copy the selection, or fall back to the terminal's default
  // (SIGINT on Windows/Linux, nothing on macOS) when nothing is selected.
  return event.hasSelection ? "copy" : "passthrough";
}

/** Best-effort detection of an Apple keyboard layout for the Cmd vs Ctrl chord. */
export function isMacPlatform(
  nav: { platform?: string; userAgent?: string } = typeof navigator !== "undefined"
    ? navigator
    : {}
): boolean {
  const platform = nav.platform ?? "";
  if (platform) {
    return /^(Mac|iPhone|iPad|iPod)/i.test(platform);
  }
  return /(Macintosh|Mac OS X|iPhone|iPad|iPod)/i.test(nav.userAgent ?? "");
}
