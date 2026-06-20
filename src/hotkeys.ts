export interface ParsedShortcut {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** Comparison key, always lowercase. */
  key: string;
}

/** Minimal structural shape of a keyboard event, so this module needs no DOM lib. */
export interface KeyboardLike {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  key: string;
  /** Optional physical key code (e.g. "KeyT"), used as a fallback when modifiers compose a different `key`. */
  code?: string;
}

/**
 * Parses a `Mod+...+Key` shortcut string (e.g. "Alt+T", "Ctrl+Shift+J").
 * Returns null for empty input, no key, or more than one non-modifier key.
 * Any single non-modifier token (e.g. "T", "Up", "Enter", "F5") is accepted as
 * the key. Modifier names are
 * case-insensitive; aliases: Control=Ctrl, Cmd/Command=Meta.
 */
export function parseShortcut(input: string): ParsedShortcut | null {
  if (typeof input !== "string") {
    return null;
  }
  const tokens = input
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (tokens.length === 0) {
    return null;
  }

  const result: ParsedShortcut = { ctrl: false, alt: false, shift: false, meta: false, key: "" };
  let key: string | null = null;

  for (const token of tokens) {
    switch (token.toLowerCase()) {
      case "ctrl":
      case "control":
        result.ctrl = true;
        break;
      case "alt":
      case "option":
        result.alt = true;
        break;
      case "shift":
        result.shift = true;
        break;
      case "meta":
      case "cmd":
      case "command":
        result.meta = true;
        break;
      default:
        if (key !== null) {
          // More than one non-modifier key is not a valid shortcut.
          return null;
        }
        key = token.toLowerCase();
    }
  }

  if (key === null) {
    return null;
  }
  result.key = key;
  return result;
}

/**
 * True when the event's modifiers and key match the parsed shortcut. Falls back
 * to the physical `event.code` for single letters/digits so that modifier-composed
 * characters (e.g. macOS Option+T producing "†") still match "Alt+T".
 */
export function matchesShortcut(event: KeyboardLike, parsed: ParsedShortcut): boolean {
  if (
    event.ctrlKey !== parsed.ctrl ||
    event.altKey !== parsed.alt ||
    event.shiftKey !== parsed.shift ||
    event.metaKey !== parsed.meta
  ) {
    return false;
  }
  if (event.key.toLowerCase() === parsed.key) {
    return true;
  }
  if (event.code && parsed.key.length === 1) {
    if (parsed.key >= "a" && parsed.key <= "z") {
      return event.code === "Key" + parsed.key.toUpperCase();
    }
    if (parsed.key >= "0" && parsed.key <= "9") {
      return event.code === "Digit" + parsed.key;
    }
  }
  return false;
}
