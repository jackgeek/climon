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
