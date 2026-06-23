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
const MAX_TITLE_LENGTH = 256;

/**
 * Removes control characters (which could carry their own escape sequences) and
 * caps length. Applied to every name before it reaches the terminal, and to
 * titles read back from the terminal before they are stored as a session name.
 */
export function sanitizeTitle(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, MAX_TITLE_LENGTH);
}

/** OSC 0 sets both the icon name and the window/tab title. */
export function titleSetSequence(name: string): string {
  return `\x1b]0;${sanitizeTitle(name)}\x07`;
}

export function titleClearSequence(): string {
  return "\x1b]0;\x07";
}

interface TitleOutput {
  isTTY?: boolean;
  write(data: string): unknown;
}

/**
 * Applies session-name changes to a terminal's title. Tracks whether it has set
 * a title so an empty name (or a detach/exit) only clears a title climon set,
 * never one the user's shell owns. All operations are no-ops on a non-TTY.
 */
export class TitleController {
  private titleSet = false;

  constructor(private readonly out: TitleOutput) {}

  apply(name: string): void {
    if (!this.out.isTTY) {
      return;
    }
    const clean = sanitizeTitle(name);
    if (clean.length > 0) {
      this.out.write(titleSetSequence(clean));
      this.titleSet = true;
    } else if (this.titleSet) {
      this.out.write(titleClearSequence());
      this.titleSet = false;
    }
  }

  clear(): void {
    if (!this.out.isTTY) {
      return;
    }
    if (this.titleSet) {
      this.out.write(titleClearSequence());
      this.titleSet = false;
    }
  }
}
