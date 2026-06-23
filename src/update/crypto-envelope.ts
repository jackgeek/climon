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
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/** Envelope scheme identifier, stored in `manifest.encryption`. */
export const ENVELOPE_SCHEME = "aes-256-gcm-scrypt-v1";

/** 7-byte magic prefix identifying a climon encryption envelope. */
const MAGIC = Buffer.from("CLMENV1", "ascii");
const SALT_LEN = 16;
const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16;
const KEY_LEN = 32; // AES-256
// scrypt cost: N=2^15. maxmem must exceed 128*N*r (~33.5MB) plus overhead.
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LEN, SCRYPT_PARAMS);
}

/**
 * Encrypts plaintext into a self-describing envelope:
 * [MAGIC(7)][salt(16)][iv(12)][tag(16)][ciphertext...].
 */
export function encryptEnvelope(
  plaintext: Uint8Array,
  password: string
): Uint8Array {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([
    cipher.update(Buffer.from(plaintext)),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([MAGIC, salt, iv, tag, body]));
}

export type DecryptResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "malformed" | "wrong-password" };

/**
 * Decrypts an envelope produced by {@link encryptEnvelope}. Never throws.
 * A wrong/rotated password or any tampering fails GCM authentication and is
 * reported as `wrong-password`; a short or mis-magic buffer is `malformed`.
 */
export function decryptEnvelope(
  envelope: Uint8Array,
  password: string
): DecryptResult {
  const buf = Buffer.from(envelope);
  const headerLen = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
  if (buf.length < headerLen || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    return { ok: false, reason: "malformed" };
  }
  let off = MAGIC.length;
  const salt = buf.subarray(off, off + SALT_LEN);
  off += SALT_LEN;
  const iv = buf.subarray(off, off + IV_LEN);
  off += IV_LEN;
  const tag = buf.subarray(off, off + TAG_LEN);
  off += TAG_LEN;
  const body = buf.subarray(off);
  try {
    const key = deriveKey(password, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(body), decipher.final()]);
    return { ok: true, bytes: new Uint8Array(out) };
  } catch {
    return { ok: false, reason: "wrong-password" };
  }
}
