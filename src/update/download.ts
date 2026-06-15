import { writeFileSync } from "node:fs";

/** Downloads a URL to `dest`, returning the bytes. Throws on non-2xx. */
export async function downloadToFile(
  url: string,
  dest: string
): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(dest, bytes);
  return bytes;
}

/** Downloads a small text resource (e.g. a .sig), returning trimmed text. */
export async function downloadText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  return (await res.text()).trim();
}
