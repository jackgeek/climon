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
 * Fixed-capacity rolling buffer of recent terminal output. Keeps at most
 * `capacity` bytes so a freshly attached client (local or web) can replay the
 * most recent screen state instead of seeing a blank terminal.
 */
export class ScrollbackBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly capacity = 256 * 1024) {}

  append(data: Buffer | string): void {
    const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    if (chunk.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    this.trim();
  }

  private trim(): void {
    while (this.size > this.capacity && this.chunks.length > 0) {
      const head = this.chunks[0];
      const overflow = this.size - this.capacity;
      if (head.length <= overflow) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(overflow);
        this.size -= overflow;
      }
    }
  }

  snapshot(): Buffer {
    return this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size);
  }

  get byteLength(): number {
    return this.size;
  }
}
