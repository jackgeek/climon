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
 * Signed, replay-protected envelope for server→devbox mux control messages.
 * Byte-for-byte counterpart of `rust/climon-remote/src/spawn_auth.rs`.
 *
 * The signed `payload` is the JSON string of an inner ControlMessage and is
 * transmitted verbatim; the signature covers the exact bytes that travel, so no
 * cross-language canonical JSON is needed — sign over what you send, verify over
 * what you receive, then parse.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import type { ControlMessage } from "./mux.js";

/** Default acceptance window for timestamp freshness + replay tracking (ms). */
export const DEFAULT_FRESHNESS_WINDOW_MS = 30_000;

export type SignedEnvelope = Extract<ControlMessage, { kind: "signed" }>;

export type VerifyResult =
  | { ok: true; message: ControlMessage }
  | { ok: false; reason: "bad-signature" | "stale" | "replay" | "bad-payload" | "not-signed" };

/** The canonical string the HMAC is computed over. */
function signingInput(payload: string, nonce: string, ts: number): string {
  return `${payload}\n${nonce}\n${ts}`;
}

function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

/** Constant-time hex comparison. Lengths differing is treated as not-equal. */
function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** A random 16-byte nonce, lowercase hex. */
export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Wraps `message` in a signed envelope using the given nonce/ts (test seam). */
export function signControl(
  secret: string,
  message: ControlMessage,
  nonce: string,
  ts: number
): SignedEnvelope {
  const payload = JSON.stringify(message);
  const sig = hmacHex(secret, signingInput(payload, nonce, ts));
  return { kind: "signed", payload, nonce, ts, sig };
}

/** Convenience: sign with a fresh nonce and the supplied current time (ms). */
export function signNow(secret: string, message: ControlMessage, nowMs: number): SignedEnvelope {
  return signControl(secret, message, newNonce(), nowMs);
}

/** Tracks recently-seen nonces within a freshness window to reject replays. */
export class ReplayGuard {
  private seen = new Map<string, number>();
  constructor(private readonly windowMs: number) {}

  check(nonce: string, ts: number, nowMs: number): "ok" | "stale" | "replay" {
    if (Math.abs(nowMs - ts) > this.windowMs) return "stale";
    this.prune(nowMs);
    if (this.seen.has(nonce)) return "replay";
    this.seen.set(nonce, ts);
    return "ok";
  }

  private prune(nowMs: number): void {
    for (const [n, t] of this.seen) {
      if (nowMs - t > this.windowMs) this.seen.delete(n);
    }
  }
}

/**
 * Verifies a signed envelope against `secret` and the replay guard, returning
 * the decoded inner control message on success. Signature is checked first so
 * forged messages never touch the replay guard.
 */
export function verifySignedControl(
  secret: string,
  envelope: ControlMessage,
  guard: ReplayGuard,
  nowMs: number
): VerifyResult {
  if (envelope.kind !== "signed") return { ok: false, reason: "not-signed" };
  const expected = hmacHex(secret, signingInput(envelope.payload, envelope.nonce, envelope.ts));
  if (!constantTimeEqualHex(expected, envelope.sig)) return { ok: false, reason: "bad-signature" };
  const replay = guard.check(envelope.nonce, envelope.ts, nowMs);
  if (replay === "stale") return { ok: false, reason: "stale" };
  if (replay === "replay") return { ok: false, reason: "replay" };
  let message: ControlMessage;
  try {
    message = JSON.parse(envelope.payload) as ControlMessage;
  } catch {
    return { ok: false, reason: "bad-payload" };
  }
  return { ok: true, message };
}
