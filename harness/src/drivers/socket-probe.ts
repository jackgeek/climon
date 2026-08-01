/**
 * Shell-free socket probe driver.
 *
 * Parses socket references (loopback TCP or absolute Unix paths), then
 * provides condition-based polling using `node:net` with bounded absolute
 * deadlines. No arbitrary sleeps; all waits are deadline-driven.
 *
 * Windows note: TCP loopback refs are supported on all platforms. Named-pipe
 * refs (`\\.\pipe\…`) are rejected at parse time with a prerequisite-failure
 * message so callers can surface a clear error rather than a misparse.
 */

import net from "node:net";
import { stat } from "node:fs/promises";

// ── Public types ─────────────────────────────────────────────────────────────

/** A parsed, validated socket reference. */
export type SocketRef =
  | { kind: "tcp"; host: "127.0.0.1"; port: number; raw: string }
  | { kind: "unix"; path: string; raw: string };

export class SocketProbeError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SocketProbeError";
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse a raw socket reference string into a typed {@link SocketRef}.
 *
 * Accepted forms:
 *   - `tcp://127.0.0.1:<port>` — loopback TCP, port 1–65535, no credentials,
 *     path segments, or query strings.
 *   - `/absolute/path` — absolute Unix socket path.
 *
 * Rejected forms (with explicit errors):
 *   - `tcp://` with any other host, credentials, path, or query.
 *   - `\\.\pipe\…` Windows named pipes — fails prerequisite explicitly.
 *   - Anything else that cannot be resolved unambiguously.
 */
export function parseSocketRef(raw: string): SocketRef {
  if (raw.startsWith("tcp://")) {
    return parseTcpRef(raw);
  }

  // Windows named pipes — reject clearly so callers surface a prerequisite error.
  if (
    raw.startsWith("\\\\.\\pipe\\") ||
    raw.startsWith("\\\\") ||
    raw.toLowerCase().startsWith("pipe://")
  ) {
    throw new SocketProbeError(
      `Named pipe socket refs are not supported by the socket probe: "${raw}". ` +
        `This is a prerequisite failure — check whether TCP is available for this platform.`
    );
  }

  if (raw.startsWith("/")) {
    return { kind: "unix", path: raw, raw };
  }

  throw new SocketProbeError(
    `Cannot parse socket ref "${raw}": ` +
      `expected tcp://127.0.0.1:<port> or an absolute Unix socket path starting with "/".`
  );
}

function parseTcpRef(raw: string): SocketRef {
  // Accept ONLY exactly tcp://127.0.0.1:<port> — nothing else.
  // We parse via URL to catch all the edge cases (credentials, path, query, hash).
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SocketProbeError(
      `Invalid TCP socket ref "${raw}": could not parse as URL. ` +
        `Expected tcp://127.0.0.1:<port>.`
    );
  }

  if (url.protocol !== "tcp:") {
    throw new SocketProbeError(
      `Invalid TCP socket ref "${raw}": protocol must be tcp:, got ${url.protocol}.`
    );
  }

  if (url.hostname !== "127.0.0.1") {
    throw new SocketProbeError(
      `Invalid TCP socket ref "${raw}": only loopback address 127.0.0.1 is accepted, ` +
        `got "${url.hostname}". Non-loopback TCP refs are not permitted.`
    );
  }

  if (url.username !== "" || url.password !== "") {
    throw new SocketProbeError(
      `Invalid TCP socket ref "${raw}": credentials are not permitted in socket refs.`
    );
  }

  if (url.pathname !== "/" && url.pathname !== "") {
    throw new SocketProbeError(
      `Invalid TCP socket ref "${raw}": path component is not permitted, got "${url.pathname}".`
    );
  }

  if (url.search !== "") {
    throw new SocketProbeError(
      `Invalid TCP socket ref "${raw}": query string is not permitted, got "${url.search}".`
    );
  }

  if (url.hash !== "") {
    throw new SocketProbeError(
      `Invalid TCP socket ref "${raw}": fragment is not permitted, got "${url.hash}".`
    );
  }

  const portStr = url.port;
  if (portStr === "") {
    throw new SocketProbeError(
      `Invalid TCP socket ref "${raw}": port is required.`
    );
  }

  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SocketProbeError(
      `Invalid TCP socket ref "${raw}": port ${portStr} is out of the valid range 1–65535.`
    );
  }

  return { kind: "tcp", host: "127.0.0.1", port, raw };
}

// ── Connection helpers ────────────────────────────────────────────────────────

/**
 * Attempt one connection to the socket. Resolves to `true` if the connection
 * succeeded, `false` if it was refused or the socket does not exist. Never
 * throws.
 */
export function tryConnect(ref: SocketRef): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;

    const settle = (result: boolean): void => {
      if (!settled) {
        settled = true;
        // destroy() is idempotent; the socket may already be gone.
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        resolve(result);
      }
    };

    const connectOptions =
      ref.kind === "tcp"
        ? { host: ref.host, port: ref.port }
        : { path: ref.path };

    const socket = net.createConnection(connectOptions);

    socket.on("connect", () => settle(true));
    socket.on("error", () => settle(false));
    // "close" fires after "error" on refused connections; guard with `settled`.
    socket.on("close", () => settle(false));
  });
}

async function fsPathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ── SocketProbe ───────────────────────────────────────────────────────────────

export interface SocketProbeOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  /** Override the filesystem existence check (for testing). */
  pathExists?: (p: string) => Promise<boolean>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deadline-driven socket probe.
 *
 * All waits use the absolute `deadline` (milliseconds since epoch) passed to
 * each method — no relative sleeps. The poll interval is bounded so we never
 * sleep past the deadline.
 */
export class SocketProbe {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly checkPathExists: (p: string) => Promise<boolean>;

  public constructor(options: SocketProbeOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.checkPathExists = options.pathExists ?? fsPathExists;
  }

  /**
   * Poll until the socket accepts connections, or throw {@link SocketProbeError}
   * if the deadline is reached first.
   */
  public async waitOpen(ref: SocketRef, deadline: number): Promise<void> {
    while (true) {
      if (await tryConnect(ref)) {
        return;
      }
      if (this.now() >= deadline) {
        throw new SocketProbeError(
          `Timed out waiting for socket to open: ${ref.raw}`
        );
      }
      await this.sleep(this.boundedPollMs(deadline));
    }
  }

  /**
   * Poll until the socket refuses connections (and, for Unix sockets, its
   * filesystem path is absent), or throw {@link SocketProbeError} if the
   * deadline is reached first.
   *
   * For Unix sockets, connection refusal alone is not sufficient: the kernel
   * may refuse a new connection while the socket file is still present (e.g.
   * the daemon is shutting down listeners). Both conditions must be satisfied.
   */
  public async waitClosed(ref: SocketRef, deadline: number): Promise<void> {
    while (true) {
      const connected = await tryConnect(ref);
      if (connected) {
        if (this.now() >= deadline) {
          throw new SocketProbeError(
            `Timed out waiting for socket to close: ${ref.raw}`
          );
        }
        await this.sleep(this.boundedPollMs(deadline));
        continue;
      }

      // Connection refused — for Unix sockets additionally require path removal.
      if (ref.kind === "unix") {
        const exists = await this.checkPathExists(ref.path);
        if (exists) {
          if (this.now() >= deadline) {
            throw new SocketProbeError(
              `Timed out waiting for Unix socket file to be removed: ${ref.path}`
            );
          }
          await this.sleep(this.boundedPollMs(deadline));
          continue;
        }
      }

      return;
    }
  }

  /**
   * Attempt exactly one connection. Returns `true` if the socket is open,
   * `false` if it is closed. Never throws.
   */
  public async probeOnce(ref: SocketRef): Promise<boolean> {
    return tryConnect(ref);
  }

  private boundedPollMs(deadline: number): number {
    return Math.max(1, Math.min(this.pollIntervalMs, deadline - this.now()));
  }
}
