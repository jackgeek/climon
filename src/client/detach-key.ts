/**
 * Renders a control-byte detach prefix as a human-readable key name (e.g. 0x1c
 * -> "Ctrl-\\"). Control bytes are ASCII letter/symbol + 0x40. Non-control bytes
 * fall back to a hex code.
 */
export function describeDetachKey(byte: number): string {
  if (byte >= 0x01 && byte <= 0x1f) {
    return `Ctrl-${String.fromCharCode(byte + 0x40)}`;
  }
  return `0x${byte.toString(16).padStart(2, "0")}`;
}
