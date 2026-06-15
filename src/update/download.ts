import { writeFileSync } from "node:fs";

/** Max bytes for a downloaded release artifact (zip of compiled binaries). */
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
/** Max bytes for a small text resource such as a detached signature. */
const MAX_TEXT_BYTES = 64 * 1024;

/** Rejects early when the server advertises a body larger than `max`. */
function checkDeclaredSize(res: Response, max: number, url: string): void {
  const len = res.headers.get("content-length");
  if (len === null) return;
  const n = Number(len);
  if (Number.isFinite(n) && n > max) {
    throw new Error(`Download too large: ${n} bytes exceeds ${max} for ${url}`);
  }
}

/**
 * Reads the response body, aborting if it exceeds `max` bytes. The Content-Length
 * header can lie, so the cap is enforced while streaming as well.
 */
async function readBounded(
  res: Response,
  max: number,
  url: string
): Promise<Uint8Array> {
  const body = res.body;
  if (!body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > max) {
      throw new Error(`Download too large: exceeds ${max} bytes for ${url}`);
    }
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`Download too large: exceeds ${max} bytes for ${url}`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Downloads a URL to `dest`, returning the bytes. Throws on non-2xx or oversize. */
export async function downloadToFile(
  url: string,
  dest: string,
  maxBytes: number = MAX_ARTIFACT_BYTES
): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  checkDeclaredSize(res, maxBytes, url);
  const bytes = await readBounded(res, maxBytes, url);
  writeFileSync(dest, bytes);
  return bytes;
}

/** Downloads a small text resource (e.g. a .sig), returning trimmed text. */
export async function downloadText(
  url: string,
  maxBytes: number = MAX_TEXT_BYTES
): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  checkDeclaredSize(res, maxBytes, url);
  const bytes = await readBounded(res, maxBytes, url);
  return new TextDecoder().decode(bytes).trim();
}
