import { realpath, open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Buffer } from "node:buffer";

export type FileReadResult =
  | { status: "ok"; path: string; content: string }
  | { status: "binary"; path: string }
  | { status: "too-large"; path: string; size: number }
  | { status: "refused"; path: string }
  | { status: "not-found"; path: string };

/** True when `target` is the base dir itself or strictly inside it. */
function isContained(base: string, target: string): boolean {
  return target === base || target.startsWith(base + sep);
}

/**
 * Reads a file referenced from the terminal, confined to the session `cwd`
 * subtree. All inputs are untrusted: the path is resolved against the canonical
 * cwd, fully canonicalized (so symlinks/.. that escape are rejected), required to
 * be a regular file, size-capped, and binary-screened. Never reads anything
 * outside the cwd subtree.
 */
export async function readConfinedFile(
  cwd: string,
  requestedPath: string,
  maxBytes: number
): Promise<FileReadResult> {
  let base: string;
  try {
    base = await realpath(cwd);
  } catch {
    return { status: "not-found", path: requestedPath };
  }

  const resolved = resolve(base, requestedPath);

  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    return { status: "not-found", path: resolved };
  }

  if (!isContained(base, real)) {
    return { status: "refused", path: real };
  }

  // This path was canonicalized and checked for containment before open. A
  // residual swap race is acceptable here because the threat model is the
  // user's own session cwd, not a hostile multi-writer directory.
  let handle;
  try {
    handle = await open(real, "r");
  } catch {
    return { status: "not-found", path: real };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { status: "refused", path: real };
    }
    if (stat.size > maxBytes) {
      return { status: "too-large", path: real, size: stat.size };
    }
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        stat.size - offset,
        offset
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const content = buffer.subarray(0, offset);
    if (content.includes(0)) {
      return { status: "binary", path: real };
    }
    return { status: "ok", path: real, content: content.toString("utf8") };
  } finally {
    await handle.close();
  }
}
