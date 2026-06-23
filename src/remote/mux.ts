import { Buffer } from "node:buffer";
import type { SessionMeta, SessionMetaPatch } from "../types.js";

export enum MuxType {
  Control = 1,
  Data = 2
}

const HEADER_SIZE = 5; // 4-byte length + 1-byte type
export const MAX_MUX_PAYLOAD = 8 * 1024 * 1024;

export type ControlMessage =
  | { kind: "hello"; clientId: string }
  | { kind: "session-added"; meta: SessionMeta }
  | { kind: "session-updated"; id: string; patch: SessionMetaPatch }
  | { kind: "session-removed"; id: string }
  | { kind: "session-list"; ids: string[] }
  | { kind: "attach"; id: string }
  | { kind: "detach"; id: string }
  | {
      kind: "spawn";
      requestId: string;
      command: string[];
      cwd: string;
      cols: number;
      rows: number;
      name?: string;
      priority?: number;
      color?: string;
      theme?: string;
      headless: boolean;
    }
  | { kind: "spawn-result"; requestId: string; id?: string; warning?: string; error?: string }
  | { kind: "signed"; payload: string; nonce: string; ts: number; sig: string }
  | { kind: "ping" }
  | { kind: "pong" };

export type MuxMessage =
  | { type: "control"; message: ControlMessage }
  | { type: "data"; sessionId: string; data: Buffer };

function envelope(type: MuxType, payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  frame.writeUInt8(type, 4);
  payload.copy(frame, HEADER_SIZE);
  return frame;
}

export function encodeControl(message: ControlMessage): Buffer {
  return envelope(MuxType.Control, Buffer.from(JSON.stringify(message), "utf8"));
}

export function encodeData(sessionId: string, data: Uint8Array): Buffer {
  const id = Buffer.from(sessionId, "utf8");
  if (id.length > 255) {
    throw new Error("session id too long for mux frame");
  }
  const payload = Buffer.allocUnsafe(1 + id.length + data.length);
  payload.writeUInt8(id.length, 0);
  id.copy(payload, 1);
  Buffer.from(data).copy(payload, 1 + id.length);
  return envelope(MuxType.Data, payload);
}

/**
 * Accumulates raw channel chunks and yields decoded mux messages. All input is
 * untrusted: frames larger than MAX_MUX_PAYLOAD throw so the caller can tear the
 * connection down instead of buffering unbounded memory.
 */
export class MuxDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): MuxMessage[] {
    this.buffer =
      this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const out: MuxMessage[] = [];
    while (this.buffer.length >= HEADER_SIZE) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_MUX_PAYLOAD) {
        throw new Error(`mux frame too large: ${length} bytes`);
      }
      const total = HEADER_SIZE + length;
      if (this.buffer.length < total) {
        break;
      }
      const type = this.buffer.readUInt8(4) as MuxType;
      const payload = this.buffer.subarray(HEADER_SIZE, total);
      if (type === MuxType.Control) {
        out.push({ type: "control", message: JSON.parse(payload.toString("utf8")) as ControlMessage });
      } else if (type === MuxType.Data) {
        const idLen = payload.readUInt8(0);
        const sessionId = payload.subarray(1, 1 + idLen).toString("utf8");
        out.push({ type: "data", sessionId, data: Buffer.from(payload.subarray(1 + idLen)) });
      }
      this.buffer = this.buffer.subarray(total);
    }
    return out;
  }
}
