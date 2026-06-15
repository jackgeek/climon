/**
 * Verifies a detached Ed25519 signature over `data` using a base64 raw public
 * key (32 bytes) and a base64 signature (64 bytes). Returns false on any error
 * (bad key, bad signature, mismatch) rather than throwing.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function verifySignature(
  data: Uint8Array,
  signatureB64: string,
  publicKeyB64: string
): Promise<boolean> {
  if (!publicKeyB64) return false;
  try {
    const rawKey = Buffer.from(publicKeyB64, "base64");
    const sig = Buffer.from(signatureB64, "base64");
    if (rawKey.length !== 32 || sig.length !== 64) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(rawKey),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      toArrayBuffer(sig),
      toArrayBuffer(data)
    );
  } catch {
    return false;
  }
}
