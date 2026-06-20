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
}

/**
 * Parses a `Mod+...+Key` shortcut string (e.g. "Alt+T", "Ctrl+Shift+J").
 * Returns null for empty, malformed, or unknown input. Modifier names are
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

/** True when the event's modifiers and key exactly match the parsed shortcut. */
export function matchesShortcut(event: KeyboardLike, parsed: ParsedShortcut): boolean {
  return (
    event.ctrlKey === parsed.ctrl &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift &&
    event.metaKey === parsed.meta &&
    event.key.toLowerCase() === parsed.key
  );
}
