export interface Mods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export type SpecialKey =
  | "Esc"
  | "Tab"
  | "Enter"
  | "Up"
  | "Down"
  | "Left"
  | "Right"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown"
  | "Delete"
  | "F1"
  | "F2"
  | "F3"
  | "F4"
  | "F5"
  | "F6"
  | "F7"
  | "F8"
  | "F9"
  | "F10"
  | "F11"
  | "F12";

// xterm modifier parameter: 1 + bitmask(shift=1, alt=2, ctrl=4).
function modParam(mods: Mods): number {
  let bits = 0;
  if (mods.shift) bits |= 1;
  if (mods.alt) bits |= 2;
  if (mods.ctrl) bits |= 4;
  return 1 + bits;
}

// Compose the single-key field char with modifiers.
export function encodeChar(char: string, mods: Mods): string {
  if (!char) {
    return "";
  }
  let base = char;
  if (mods.shift) {
    base = base.toUpperCase();
  }
  if (mods.ctrl) {
    // Control byte from the letter, case-insensitive.
    const code = base.toUpperCase().charCodeAt(0) & 0x1f;
    base = String.fromCharCode(code);
  }
  if (mods.alt) {
    base = "\x1b" + base;
  }
  return base;
}

// CSI cursor/navigation finals.
const CURSOR_FINAL: Partial<Record<SpecialKey, string>> = {
  Up: "A",
  Down: "B",
  Right: "C",
  Left: "D",
  Home: "H",
  End: "F"
};

// Tilde-form sequence numbers.
const TILDE_NUM: Partial<Record<SpecialKey, number>> = {
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24
};

// SS3 final bytes for F1-F4.
const SS3_FINAL: Partial<Record<SpecialKey, string>> = {
  F1: "P",
  F2: "Q",
  F3: "R",
  F4: "S"
};

function hasMod(mods: Mods): boolean {
  return mods.ctrl || mods.alt || mods.shift;
}

// Only Alt is set (used to pick the ESC-prefix form for special keys).
function altOnly(mods: Mods): boolean {
  return mods.alt && !mods.ctrl && !mods.shift;
}

export function encodeSpecial(key: SpecialKey, mods: Mods): string {
  if (key === "Esc") {
    return "\x1b";
  }
  if (key === "Enter") {
    return "\r";
  }
  if (key === "Tab") {
    return mods.shift ? "\x1b[Z" : "\t";
  }

  const cursor = CURSOR_FINAL[key];
  if (cursor) {
    if (altOnly(mods)) {
      return "\x1b\x1b[" + cursor;
    }
    if (hasMod(mods)) {
      return `\x1b[1;${modParam(mods)}${cursor}`;
    }
    return "\x1b[" + cursor;
  }

  const ss3 = SS3_FINAL[key];
  if (ss3) {
    if (altOnly(mods)) {
      return "\x1b\x1bO" + ss3;
    }
    if (hasMod(mods)) {
      return `\x1b[1;${modParam(mods)}${ss3}`;
    }
    return "\x1bO" + ss3;
  }

  const num = TILDE_NUM[key];
  if (num !== undefined) {
    if (altOnly(mods)) {
      return `\x1b\x1b[${num}~`;
    }
    if (hasMod(mods)) {
      return `\x1b[${num};${modParam(mods)}~`;
    }
    return `\x1b[${num}~`;
  }

  return "";
}
