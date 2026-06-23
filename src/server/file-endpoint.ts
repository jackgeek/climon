import type { SessionMeta } from "../types.js";
import { isValidRemoteId } from "../remote/ingest.js";
import { readConfinedFile, type FileReadResult } from "./file-read.js";

export interface FileRequestBody {
  session: string;
  path: string;
}

export interface FileRequestDeps {
  enabled: boolean;
  maxBytes: number;
  loadMeta: (id: string) => Promise<SessionMeta | null>;
  readRemoteFile?: (sessionId: string, path: string, maxBytes: number) => Promise<FileReadResult>;
}

export interface FileResponse {
  status: number;
  body: FileReadResult | { status: "error"; message: string };
}

function isValidSessionId(id: unknown): id is string {
  // Remote session ids are namespaced as label~remoteId; isValidRemoteId excludes "~",
  // so validate each segment instead of rejecting every remote session.
  return typeof id === "string" && id.split("~").every((part) => isValidRemoteId(part));
}

/**
 * Pure request handler for POST /api/file. The session id is validated before any
 * filesystem access (SEC-1); the cwd is taken from server-side metadata, never
 * from the client. Remote sessions are routed through `deps.readRemoteFile`
 * (the ingest control socket); when that dependency is absent they return 501.
 */
export async function handleFileRequest(
  body: FileRequestBody,
  deps: FileRequestDeps
): Promise<FileResponse> {
  if (!deps.enabled) {
    return { status: 404, body: { status: "error", message: "file viewer disabled" } };
  }
  if (!isValidSessionId(body.session)) {
    return { status: 400, body: { status: "error", message: "invalid session id" } };
  }
  if (typeof body.path !== "string" || body.path.length === 0) {
    return { status: 400, body: { status: "error", message: "missing path" } };
  }
  const meta = await deps.loadMeta(body.session);
  if (!meta) {
    return { status: 404, body: { status: "error", message: "unknown session" } };
  }
  if (meta.origin === "remote") {
    if (!deps.readRemoteFile) {
      return { status: 501, body: { status: "error", message: "remote file viewing not yet available" } };
    }
    const result = await deps.readRemoteFile(meta.id, body.path, deps.maxBytes);
    return { status: 200, body: result };
  }
  const result = await readConfinedFile(meta.cwd, body.path, deps.maxBytes);
  return { status: 200, body: result };
}
