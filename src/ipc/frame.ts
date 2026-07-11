import { Buffer } from "node:buffer";
import { POST_AUTH_MAX_PAYLOAD } from "./auth.js";

/** IPC frame type tags mirrored from rust/climon-proto/src/frame.rs. */
export enum FrameType {
  Output = 1,
  Input = 2,
  Resize = 3,
  Exit = 4,
  Replay = 5,
  PtySize = 6,
  Attention = 7,
  Title = 8,
  // Tags 9 and 10 are reserved (previously used) and intentionally left unused
  // so existing tag numbers stay stable.
  Control = 11,
  TakeControl = 12,
  AuthChallenge = 13,
  AuthResponse = 14,
  AuthOk = 15,
  AuthError = 16,
  AuthProbeOk = 17,
}

/** Surface categories that can participate in terminal control handoff. */
export type SurfaceKind = "terminal" | "dashboard" | "pwa";

export interface ResizePayload {
  cols: number;
  rows: number;
  /** Kind of surface requesting or reporting the resize. */
  kind?: SurfaceKind;
  /** Stable viewer identity for dashboard/PWA surfaces. */
  viewerId?: string;
}

/** Announces the active terminal controller and its current size. */
export interface ControlPayload {
  controllerId: string;
  cols: number;
  rows: number;
}

export interface PtySizePayload {
  cols: number;
  rows: number;
}

export interface AttentionPayload {
  needsAttention: boolean;
  reason?: string;
  attentionMatchedAt?: string;
}

export interface ExitPayload {
  exitCode: number;
}

export interface TitlePayload {
  /** The session name to show as the terminal title. Empty string clears it. */
  name: string;
}

const HEADER_SIZE = 5; // 4-byte length + 1-byte type

export function encodeFrame(type: FrameType, payload: Uint8Array | string = new Uint8Array(0)): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  const frame = Buffer.allocUnsafe(HEADER_SIZE + body.length);
  frame.writeUInt32BE(body.length, 0);
  frame.writeUInt8(type, 4);
  body.copy(frame, HEADER_SIZE);
  return frame;
}

export function encodeJsonFrame(type: FrameType, value: unknown): Buffer {
  return encodeFrame(type, JSON.stringify(value));
}

export interface DecodedFrame {
  type: FrameType;
  payload: Buffer;
}

/**
 * Accumulates raw socket chunks and yields complete frames. Handles payloads
 * split across multiple chunks and multiple frames within a single chunk.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private _maxPayload: number = POST_AUTH_MAX_PAYLOAD;
  private _errored: boolean = false;

  get errored(): boolean {
    return this._errored;
  }

  setMaxPayload(n: number): void {
    this._maxPayload = n;
  }

  push(chunk: Uint8Array): DecodedFrame[] {
    if (this._errored) return [];
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames: DecodedFrame[] = [];
    while (this.buffer.length >= HEADER_SIZE) {
      const length = this.buffer.readUInt32BE(0);
      if (length > this._maxPayload) {
        this._errored = true;
        this.buffer = Buffer.alloc(0);
        break;
      }
      const total = HEADER_SIZE + length;
      if (this.buffer.length < total) {
        break;
      }
      const type = this.buffer.readUInt8(4) as FrameType;
      const payload = this.buffer.subarray(HEADER_SIZE, total);
      frames.push({ type, payload: Buffer.from(payload) });
      this.buffer = this.buffer.subarray(total);
    }
    return frames;
  }
}

export function parseJsonPayload<T>(payload: Buffer): T {
  return JSON.parse(payload.toString("utf8")) as T;
}
