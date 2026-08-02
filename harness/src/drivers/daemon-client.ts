/**
 * Raw daemon IPC client.
 *
 * Connects shell-free to a daemon socket (TCP loopback or Unix) and waits for
 * the daemon's server-driven attach handshake: the daemon sends a PtySize frame
 * (advertising the current PTY dimensions) followed by a Replay frame (marking
 * the end of the initial scrollback burst) approximately 10 ms after the client
 * connects. The client sends no frames on connect: PtySize is outbound-only,
 * and the server's initial Replay is sufficient without requesting another.
 *
 * waitForAttached() resolves only once BOTH the PtySize and the Replay frames
 * have been received.  Receiving only one of them is insufficient.
 *
 * Two usage modes:
 *   - "healthy": continues reading frames after attach and accumulates events.
 *   - "stalled": after waitForAttached(), call pauseReads() so the OS receive
 *     buffer fills; the daemon evicts the client after its 5-second write
 *     timeout, closing the socket — detected via waitForClosed().
 *
 * Frame protocol mirrors src/ipc/frame.ts / rust/climon-proto/src/frame.rs:
 *   - 4-byte big-endian payload length
 *   - 1-byte frame type tag
 *   - N-byte payload (UTF-8 JSON for structured frames, raw bytes for Output)
 *
 * Strict validation: oversized lengths, unknown type tags, and malformed JSON
 * payloads for PtySize/Control/Exit frames are rejected with DaemonClientError
 * and the connection is torn down.
 *
 * All waits are absolute-deadline condition-based; no arbitrary sleeps. All
 * public API methods are idempotent after destroy/close.
 */

import net from "node:net";
import { Buffer } from "node:buffer";
import type { SocketRef } from "./socket-probe.js";

// ── Frame type constants ──────────────────────────────────────────────────────

/**
 * Frame type tags. Values MUST match FrameType in src/ipc/frame.ts and
 * rust/climon-proto/src/frame.rs. Tags 9 and 10 are reserved (previously used)
 * and are intentionally absent, keeping all other tag numbers stable.
 */
export enum FrameType {
  Output = 1,
  Input = 2,
  Resize = 3,
  Exit = 4,
  Replay = 5,
  PtySize = 6,
  Attention = 7,
  Title = 8,
  // Tags 9 and 10: reserved / previously used — intentionally absent.
  Control = 11,
  TakeControl = 12,
}

/**
 * Maximum permitted frame payload size.
 *
 * Justification: the largest realistic payload is a full 10 000-line scrollback
 * at ~200 bytes per line ≈ 2 MiB. 8 MiB gives 4× headroom while still bounding
 * memory allocation against misbehaving or adversarial peers.
 */
export const MAX_FRAME_PAYLOAD = 8 * 1024 * 1024; // 8 MiB

const HEADER_SIZE = 5; // 4-byte length + 1-byte type

// Set of valid numeric FrameType values for O(1) membership tests.
const KNOWN_FRAME_TYPE_VALUES = new Set<number>(
  (Object.values(FrameType) as Array<string | number>).filter(
    (v): v is number => typeof v === "number"
  )
);

// ── Errors ────────────────────────────────────────────────────────────────────

export class DaemonClientError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DaemonClientError";
  }
}

// ── Payload types (mirrors src/ipc/frame.ts) ─────────────────────────────────

export interface PtySizePayload {
  cols: number;
  rows: number;
}

export interface ControlPayload {
  controllerId: string;
  cols: number;
  rows: number;
}

export interface ExitPayload {
  exitCode: number;
}

// ── Frame codec ───────────────────────────────────────────────────────────────

export interface DecodedFrame {
  type: FrameType;
  payload: Buffer;
}

/**
 * Accumulates raw socket bytes and yields complete decoded frames. Validates
 * payload length (rejects > MAX_FRAME_PAYLOAD) and frame type (rejects
 * unknown tags) on every push.
 */
export class FrameDecoder {
  private buf = Buffer.alloc(0);

  public push(chunk: Uint8Array): DecodedFrame[] {
    this.buf =
      this.buf.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buf, Buffer.from(chunk)]);

    const frames: DecodedFrame[] = [];

    while (this.buf.length >= HEADER_SIZE) {
      const length = this.buf.readUInt32BE(0);

      if (length > MAX_FRAME_PAYLOAD) {
        throw new DaemonClientError(
          `Oversized frame payload declared: ${length} bytes exceeds max ${MAX_FRAME_PAYLOAD} (${MAX_FRAME_PAYLOAD / 1024 / 1024} MiB)`
        );
      }

      const total = HEADER_SIZE + length;
      if (this.buf.length < total) break;

      const typeTag = this.buf.readUInt8(4);
      if (!KNOWN_FRAME_TYPE_VALUES.has(typeTag)) {
        throw new DaemonClientError(
          `Unknown frame type tag: ${typeTag}. Known tags: ${[...KNOWN_FRAME_TYPE_VALUES].sort((a, b) => a - b).join(", ")}`
        );
      }

      const type = typeTag as FrameType;
      const payload = Buffer.from(this.buf.subarray(HEADER_SIZE, total));
      frames.push({ type, payload });
      this.buf = this.buf.subarray(total);
    }

    return frames;
  }

  /** Number of bytes buffered but not yet consumed. */
  public get bufferedBytes(): number {
    return this.buf.length;
  }
}

// ── JSON payload validators ───────────────────────────────────────────────────

function parseJsonPayload<T>(payload: Buffer, frameLabel: string): T {
  const raw = payload.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new DaemonClientError(
      `Malformed JSON in ${frameLabel} frame payload: ${raw.slice(0, 200)}`,
      { cause }
    );
  }
  return value as T;
}

/**
 * Returns true for finite positive integers in the valid u16 range [1, 65535].
 * Used to validate cols/rows in PtySize and Control frames.
 */
function isValidU16Dimension(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    Number.isInteger(v) &&
    v >= 1 &&
    v <= 65535
  );
}

function validatePtySizePayload(payload: Buffer): PtySizePayload {
  const v = parseJsonPayload<Record<string, unknown>>(payload, "PtySize");
  if (!isValidU16Dimension(v.cols) || !isValidU16Dimension(v.rows)) {
    throw new DaemonClientError(
      "Invalid PtySize payload: cols and rows must be finite positive integers in the range [1, 65535]"
    );
  }
  return { cols: v.cols, rows: v.rows };
}

function validateControlPayload(payload: Buffer): ControlPayload {
  const v = parseJsonPayload<Record<string, unknown>>(payload, "Control");
  if (
    typeof v.controllerId !== "string" ||
    !isValidU16Dimension(v.cols) ||
    !isValidU16Dimension(v.rows)
  ) {
    throw new DaemonClientError(
      "Invalid Control payload: expected { controllerId: string, cols: number (u16), rows: number (u16) }"
    );
  }
  return {
    controllerId: v.controllerId,
    cols: v.cols,
    rows: v.rows,
  };
}

function validateExitPayload(payload: Buffer): ExitPayload {
  const v = parseJsonPayload<Record<string, unknown>>(payload, "Exit");
  if (
    typeof v.exitCode !== "number" ||
    !Number.isFinite(v.exitCode) ||
    !Number.isInteger(v.exitCode)
  ) {
    throw new DaemonClientError(
      "Invalid Exit payload: exitCode must be a finite integer"
    );
  }
  return { exitCode: v.exitCode as number };
}

// ── Pending wait bookkeeping ──────────────────────────────────────────────────

interface PendingWait {
  check: () => boolean;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

// ── DaemonClient ──────────────────────────────────────────────────────────────

/**
 * Shell-free raw IPC client for a climon daemon socket.
 *
 * Usage:
 *   const client = new DaemonClient(ref);
 *   await client.waitForAttached(deadline);          // healthy or stalled
 *   client.pauseReads();                             // stalled mode
 *   await client.waitForClosed(deadline);            // eviction proof
 *
 * Cleanup:
 *   client.destroy();   // idempotent; tears down the socket immediately
 *   client.close();     // idempotent graceful half-close (FIN)
 */
export class DaemonClient {
  private readonly socket: net.Socket;
  private readonly decoder = new FrameDecoder();

  // Accumulated event state.
  private readonly outputParts: string[] = [];
  private readonly controlFrames: ControlPayload[] = [];
  private exitPayload: ExitPayload | undefined;
  // Both must arrive for waitForAttached() to resolve (server-driven handshake).
  private ptySizeReceived = false;
  private replayReceived = false;

  // Socket lifecycle state.
  private socketError: Error | undefined;
  private socketClosed = false;
  private destroyed = false;

  // Condition waiters.
  private readonly pendingWaits = new Set<PendingWait>();

  public constructor(ref: SocketRef) {
    const connectOptions: net.NetConnectOpts =
      ref.kind === "tcp"
        ? { host: ref.host, port: ref.port }
        : { path: ref.path };

    this.socket = net.createConnection(connectOptions);

    // The daemon drives the attach handshake — the client sends nothing on
    // connect.  The daemon sends PtySize (current PTY dimensions) followed by
    // Replay (end of initial scrollback) approximately 10 ms after the socket
    // is established.

    this.socket.on("data", (chunk: Buffer) => {
      this.handleData(chunk);
    });

    this.socket.on("error", (err: Error) => {
      this.handleError(err);
    });

    this.socket.on("close", () => {
      this.handleClose();
    });

    // "end" fires when the remote end sends FIN; we treat it as closed too.
    this.socket.on("end", () => {
      this.handleClose();
    });
  }

  // ── Private event handlers ─────────────────────────────────────────────────

  private handleData(chunk: Buffer): void {
    let frames: DecodedFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.handleError(
        err instanceof Error ? err : new DaemonClientError(String(err))
      );
      return;
    }

    for (const frame of frames) {
      try {
        this.processFrame(frame);
      } catch (err) {
        // Trigger waits BEFORE handling the error so that any condition
        // already satisfied by frames processed earlier in this batch
        // (e.g., the PtySize + Replay pair that arrived in the same chunk
        // as a bad Control frame) resolves rather than being rejected.
        this.triggerConditionWaits();
        this.handleError(
          err instanceof Error ? err : new DaemonClientError(String(err))
        );
        return;
      }
    }

    this.triggerConditionWaits();
  }

  private processFrame(frame: DecodedFrame): void {
    switch (frame.type) {
      case FrameType.Replay:
        this.replayReceived = true;
        break;

      case FrameType.Output:
        this.outputParts.push(frame.payload.toString("utf8"));
        break;

      case FrameType.PtySize:
        // Validate and record receipt of the server-sent initial PtySize frame.
        validatePtySizePayload(frame.payload);
        this.ptySizeReceived = true;
        break;

      case FrameType.Control:
        this.controlFrames.push(validateControlPayload(frame.payload));
        break;

      case FrameType.Exit:
        this.exitPayload = validateExitPayload(frame.payload);
        break;

      default:
        // Input, Resize, Attention, Title, TakeControl: well-formed but we
        // don't act on them in this read-only client role.
        break;
    }
  }

  private handleError(err: Error): void {
    if (this.socketError !== undefined) return; // Already failed.
    this.socketError = err;
    this.rejectAllWaits(err);
    if (!this.destroyed) {
      this.socket.destroy();
    }
  }

  private handleClose(): void {
    if (this.socketClosed) return;
    this.socketClosed = true;

    // Resolve any waitForClosed waiters and reject remaining condition waiters
    // (they cannot be satisfied once the socket is gone).
    const closedErr =
      this.socketError ?? new DaemonClientError("Socket closed");

    for (const wait of this.pendingWaits) {
      if (wait.check()) {
        if (wait.timer !== null) clearTimeout(wait.timer);
        wait.resolve();
      } else {
        if (wait.timer !== null) clearTimeout(wait.timer);
        wait.reject(closedErr);
      }
    }
    this.pendingWaits.clear();
  }

  private triggerConditionWaits(): void {
    for (const wait of this.pendingWaits) {
      if (wait.check()) {
        if (wait.timer !== null) clearTimeout(wait.timer);
        this.pendingWaits.delete(wait);
        wait.resolve();
      }
    }
  }

  private rejectAllWaits(err: Error): void {
    for (const wait of this.pendingWaits) {
      if (wait.timer !== null) clearTimeout(wait.timer);
      wait.reject(err);
    }
    this.pendingWaits.clear();
  }

  /** Add a condition-based wait with an absolute deadline. */
  private conditionWait(check: () => boolean, deadline: number, label: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.socketError !== undefined) {
        reject(this.socketError);
        return;
      }
      if (check()) {
        resolve();
        return;
      }
      if (this.socketClosed) {
        reject(new DaemonClientError(`Socket already closed waiting for: ${label}`));
        return;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(new DaemonClientError(`Deadline already expired waiting for: ${label}`));
        return;
      }

      const wait: PendingWait = {
        check,
        resolve,
        reject,
        timer: null,
      };

      wait.timer = setTimeout(() => {
        this.pendingWaits.delete(wait);
        reject(new DaemonClientError(`Timed out waiting for: ${label}`));
      }, remaining);

      this.pendingWaits.add(wait);
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Wait until the daemon's server-driven attach handshake is complete:
   * the daemon must send BOTH a PtySize frame (current PTY dimensions) AND a
   * Replay frame (end of initial scrollback burst).  Receiving only one of
   * them is not sufficient — both must arrive before this resolves.
   * Control frames received at any point are recorded but do not affect this
   * condition.
   */
  public waitForAttached(deadline: number): Promise<void> {
    return this.conditionWait(
      () => this.ptySizeReceived && this.replayReceived,
      deadline,
      "PtySize + Replay frames (daemon attach handshake)"
    );
  }

  /**
   * Wait until accumulated Output frame data contains the given marker string.
   * The search is over all output received so far, not just the latest chunk.
   */
  public waitForOutput(marker: string, deadline: number): Promise<void> {
    return this.conditionWait(
      () => this.outputParts.join("").includes(marker),
      deadline,
      `output marker: ${marker}`
    );
  }

  /**
   * Wait until an Exit frame has been received from the daemon.
   */
  public waitForExit(deadline: number): Promise<void> {
    return this.conditionWait(
      () => this.exitPayload !== undefined,
      deadline,
      "Exit frame"
    );
  }

  /**
   * Wait until the underlying socket is closed (either by the daemon evicting
   * this client, or by an explicit destroy/close call). Works even while reads
   * are paused — internally resumes the socket so that RST/FIN signals can be
   * detected (libuv stops watching a paused socket, which would otherwise block
   * close/error delivery).
   */
  public waitForClosed(deadline: number): Promise<void> {
    if (this.socketClosed) return Promise.resolve();

    // Resume reads so the close/end/error events can fire even if the socket
    // was previously paused. This is safe because we are only waiting for the
    // connection to terminate — no more data processing is expected.
    if (!this.destroyed) {
      this.socket.resume();
    }

    return new Promise<void>((resolve, reject) => {
      if (this.socketError !== undefined && this.socketClosed) {
        resolve();
        return;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(new DaemonClientError("Deadline already expired waiting for socket close"));
        return;
      }

      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new DaemonClientError("Timed out waiting for socket close"));
        }
      }, remaining);

      const onClose = (): void => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve();
        }
      };

      const onError = (): void => {
        if (!settled) {
          settled = true;
          cleanup();
          // A socket error closes the socket; resolve as closed.
          resolve();
        }
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        this.socket.removeListener("close", onClose);
        this.socket.removeListener("end", onClose);
        this.socket.removeListener("error", onError);
      };

      this.socket.once("close", onClose);
      this.socket.once("end", onClose);
      this.socket.once("error", onError);
    });
  }

  /**
   * Pause reading from the socket. Outgoing data from the daemon continues to
   * accumulate in the OS kernel receive buffer; once that fills, the daemon's
   * write will time out and the client will be evicted. Use waitForClosed() to
   * detect eviction.
   */
  public pauseReads(): void {
    if (!this.destroyed && !this.socketClosed) {
      this.socket.pause();
    }
  }

  /**
   * Resume reading from the socket after a pauseReads() call. No-op if the
   * socket is already closed or destroyed.
   */
  public resume(): void {
    if (!this.destroyed && !this.socketClosed) {
      this.socket.resume();
    }
  }

  /**
   * Destroy the socket immediately. Idempotent.
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.socket.destroy();
  }

  /**
   * Send a graceful half-close (FIN). Idempotent.
   */
  public close(): void {
    if (this.destroyed || this.socketClosed) return;
    this.socket.end();
  }

  // ── Read-only accessors ────────────────────────────────────────────────────

  /** All Output frame data received so far, concatenated. */
  public get accumulatedOutput(): string {
    return this.outputParts.join("");
  }

  /** The most recently received Control frame payload, or undefined. */
  public get latestControl(): ControlPayload | undefined {
    return this.controlFrames[this.controlFrames.length - 1];
  }

  /** All Control frame payloads received so far, in order. */
  public get allControlFrames(): readonly ControlPayload[] {
    return this.controlFrames;
  }

  /** The Exit frame payload, if one has been received. */
  public get exit(): ExitPayload | undefined {
    return this.exitPayload;
  }

  /** True after the daemon's server-driven PtySize + Replay handshake frames have both been received. */
  public get attached(): boolean {
    return this.ptySizeReceived && this.replayReceived;
  }

  /** True once the socket has closed (error, remote FIN, or local destroy). */
  public get closed(): boolean {
    return this.socketClosed;
  }

  /** The socket error that caused the connection to fail, if any. */
  public get error(): Error | undefined {
    return this.socketError;
  }
}
