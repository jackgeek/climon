import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { connectSessionSocket } from "../session-socket.js";
import { readIngestState } from "../remote/ingest-state.js";
import type { FileReadResult } from "./file-read.js";

/**
 * Sends a `read-file` request to the running ingest's loopback control socket and
 * resolves with the confined file result.
 *
 * Wire framing (kept in lockstep with `serve_control_connection` in
 * `rust/climon-remote/src/ingest.rs`): the request is a single newline-delimited
 * JSON line; the reply is a small newline-delimited JSON header
 * (`{ type:"read-file-result", requestId, status, path, size?, len }`) followed by
 * exactly `len` raw UTF-8 bytes of file content. This length-prefixed body
 * sidesteps the 64 KiB `MAX_CONTROL_LINE` cap, which a 2 MiB file would exceed.
 *
 * Any transport failure (ingest down, timeout, unreachable, malformed reply) maps
 * to `{ status: "not-found", path }` so the dashboard never leaks the distinction
 * between "missing file" and "transport failure".
 */
export async function requestRemoteFileRead(
  sessionId: string,
  path: string,
  maxBytes: number,
  timeoutMs = 10_000,
  env: NodeJS.ProcessEnv = process.env
): Promise<FileReadResult> {
  const notFound: FileReadResult = { status: "not-found", path };
  const state = await readIngestState(env);
  if (!state?.controlSocket) {
    return notFound;
  }
  const requestId = randomUUID();
  const req = {
    type: "read-file",
    requestId,
    sessionId,
    path,
    maxBytes,
    ...(state.controlToken ? { controlToken: state.controlToken } : {})
  };
  return new Promise<FileReadResult>((resolve) => {
    const socket = connectSessionSocket(state.controlSocket!);
    let acc = Buffer.alloc(0);
    let header: { status?: string; path?: string; size?: number; len?: number } | null = null;
    let settled = false;
    const done = (res: FileReadResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(res);
    };
    const timer = setTimeout(() => done(notFound), timeoutMs);
    timer.unref?.();
    socket.on("connect", () => socket.write(JSON.stringify(req) + "\n"));
    socket.on("data", (chunk: Buffer) => {
      acc = Buffer.concat([acc, chunk]);
      if (!header) {
        const nl = acc.indexOf(0x0a);
        if (nl < 0) return;
        try {
          header = JSON.parse(acc.subarray(0, nl).toString("utf8"));
        } catch {
          done(notFound);
          return;
        }
        acc = acc.subarray(nl + 1);
      }
      const hdr = header;
      if (!hdr) return;
      const len = hdr.len ?? 0;
      if (acc.length < len) return;
      const body = acc.subarray(0, len).toString("utf8");
      done(buildResult(hdr, body));
    });
    socket.on("error", () => done(notFound));
    socket.on("close", () => done(notFound));
  });
}

function buildResult(
  header: { status?: string; path?: string; size?: number },
  body: string
): FileReadResult {
  const path = typeof header.path === "string" ? header.path : "";
  switch (header.status) {
    case "ok":
      return { status: "ok", path, content: body };
    case "too-large":
      return { status: "too-large", path, size: header.size ?? 0 };
    case "binary":
      return { status: "binary", path };
    case "refused":
      return { status: "refused", path };
    default:
      return { status: "not-found", path };
  }
}
