import type { SessionMeta } from "../types.js";

/**
 * The dashboard is loopback-only and unauthenticated at the HTTP layer, so API
 * paths need no query credentials. Kept as a thin indirection so call sites stay
 * stable if a query suffix is ever reintroduced.
 */
export function withQuery(path: string): string {
  return path;
}

export interface CreateSessionBody {
  command: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  /** When set, the session is spawned directly from this parent session. */
  parentId?: string;
}

export async function fetchSessions(): Promise<SessionMeta[]> {
  const res = await fetch(withQuery("/api/sessions"));
  if (!res.ok) {
    throw new Error(`Failed to load sessions (${res.status})`);
  }
  const data = (await res.json()) as { sessions?: SessionMeta[] };
  return data.sessions ?? [];
}

export interface CreateSessionResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export async function createSession(body: CreateSessionBody): Promise<CreateSessionResult> {
  try {
    const res = await fetch(withQuery("/api/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: text || `Failed (${res.status})` };
    }
    const data = (await res.json()) as { id?: string };
    return { ok: true, id: data.id };
  } catch {
    return { ok: false, error: "Network error." };
  }
}

export async function deleteSession(id: string): Promise<void> {
  try {
    await fetch(withQuery(`/api/sessions/${id}`), { method: "DELETE" });
  } catch {
    // Best effort: the SSE stream will reconcile the list regardless.
  }
}

export async function fetchScrollback(id: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(withQuery(`/api/sessions/${id}/scrollback`));
    if (!res.ok) {
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

export function eventsUrl(): string {
  return withQuery("/api/events");
}

export function attachSocketUrl(id: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/sessions/${id}/attach${location.search || ""}`;
}

export function isLiveStatus(status: SessionMeta["status"]): boolean {
  return status === "running" || status === "needs-attention";
}
