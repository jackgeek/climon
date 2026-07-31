const NAMED_KEY_SEQUENCES = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Insert: "\x1b[2~",
  Delete: "\x1b[3~",
  Enter: "\r",
  Escape: "\x1b",
  Tab: "\t",
  Backspace: "\x7f",
} as const;

const CONTROL_KEY_CODES = {
  "@": 0,
  "[": 27,
  "\\": 28,
  "]": 29,
  "^": 30,
  _: 31,
  "?": 127,
} as const;

type MouseModifiers = {
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
};

type MouseBaseEvent =
  | {
      kind: "press" | "release" | "move";
      button: 0 | 1 | 2;
      col: number;
      row: number;
      modifiers?: MouseModifiers;
    }
  | {
      kind: "wheel-up" | "wheel-down";
      col: number;
      row: number;
      modifiers?: MouseModifiers;
    };

export type NamedKey = keyof typeof NAMED_KEY_SEQUENCES;
export type MouseEvent = MouseBaseEvent;

function modifierBits(modifiers: MouseModifiers | undefined): number {
  return (modifiers?.shift ? 4 : 0) + (modifiers?.alt ? 8 : 0) + (modifiers?.ctrl ? 16 : 0);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be positive integers`);
  }
}

export function controlChord(key: string): string {
  if (/^[A-Za-z]$/.test(key)) {
    return String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64);
  }

  if (Object.hasOwn(CONTROL_KEY_CODES, key)) {
    return String.fromCharCode(CONTROL_KEY_CODES[key as keyof typeof CONTROL_KEY_CODES]);
  }

  throw new Error(`Unsupported control chord: ${key}`);
}

export function namedKey(key: NamedKey): string {
  if (Object.hasOwn(NAMED_KEY_SEQUENCES, key)) {
    return NAMED_KEY_SEQUENCES[key];
  }

  throw new Error(`Unsupported named key: ${String(key)}`);
}

export function sgrMouse(event: MouseEvent): string {
  assertPositiveInteger(event.col, "Mouse coordinates");
  assertPositiveInteger(event.row, "Mouse coordinates");

  const modifiers = modifierBits(event.modifiers);
  let code: number;
  let suffix = "M";

  switch (event.kind) {
    case "press":
      code = event.button + modifiers;
      break;
    case "release":
      code = event.button + modifiers;
      suffix = "m";
      break;
    case "move":
      code = 32 + event.button + modifiers;
      break;
    case "wheel-up":
      code = 64 + modifiers;
      break;
    case "wheel-down":
      code = 65 + modifiers;
      break;
    default:
      throw new Error(`Unsupported mouse event: ${(event as { kind: string }).kind}`);
  }

  if ("button" in event && ![0, 1, 2].includes(event.button)) {
    throw new Error(`Unsupported mouse button: ${event.button}`);
  }

  return `\x1b[<${code};${event.col};${event.row}${suffix}`;
}
