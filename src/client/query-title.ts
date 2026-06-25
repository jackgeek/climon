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

/**
 * Extracts the title from a terminal's window-title report. The reply to
 * `ESC [ 21 t` is `ESC ] l <title> ST`, where ST is `ESC \` or BEL. Returns the
 * title, or undefined if a complete reply is not present yet.
 */
export function parseTitleReply(buf: Buffer): string | undefined {
  const text = buf.toString("utf8");
  const start = text.indexOf("\x1b]l");
  if (start === -1) {
    return undefined;
  }
  const rest = text.slice(start + 3);
  const stIndex = rest.indexOf("\x1b\\");
  if (stIndex !== -1) {
    return rest.slice(0, stIndex);
  }
  const belIndex = rest.indexOf("\x07");
  if (belIndex !== -1) {
    return rest.slice(0, belIndex);
  }
  return undefined;
}

interface QueryStdin {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(value: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  removeListener(event: "data", listener: (chunk: Buffer) => void): unknown;
}

interface QueryStdout {
  isTTY?: boolean;
  write(data: string): unknown;
}

interface QueryOptions {
  stdin?: QueryStdin;
  stdout?: QueryStdout;
  timeoutMs?: number;
}

const MAX_REPLY_BYTES = 2048;

/**
 * Best-effort read of the terminal's current window title. Writes `ESC [ 21 t`
 * and waits (in raw mode) for the reply, resolving early once a complete reply
 * arrives or with undefined on timeout. Always restores the prior raw-mode state
 * and detaches its listener. Returns undefined immediately on a non-TTY.
 */
export function queryTerminalTitle(options: QueryOptions = {}): Promise<string | undefined> {
  const stdin = options.stdin ?? (process.stdin as unknown as QueryStdin);
  const stdout = options.stdout ?? (process.stdout as unknown as QueryStdout);
  const timeoutMs = options.timeoutMs ?? 150;

  if (!stdin.isTTY || !stdout.isTTY) {
    return Promise.resolve(undefined);
  }

  return new Promise<string | undefined>((resolve) => {
    let buffer = Buffer.alloc(0);
    let done = false;
    const wasRaw = stdin.isRaw === true;

    const finish = (result: string | undefined): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode?.(wasRaw);
      } catch {
        // Restoring raw mode can fail on exotic streams; ignore.
      }
      stdin.pause();
      resolve(result);
    };

    const onData = (chunk: Buffer): void => {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, Buffer.from(chunk)]);
      const title = parseTitleReply(buffer);
      if (title !== undefined) {
        finish(title);
      } else if (buffer.length > MAX_REPLY_BYTES) {
        finish(undefined);
      }
    };

    const timer = setTimeout(() => finish(undefined), timeoutMs);

    try {
      stdin.setRawMode?.(true);
    } catch {
      // ignore
    }
    stdin.resume();
    stdin.on("data", onData);
    stdout.write("\x1b[21t");
  });
}
