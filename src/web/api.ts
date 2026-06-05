import type { AnsiColor, SessionColorMode, SessionMeta } from "../types.js";

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
  name?: string;
  priority?: number;
  color?: SessionColorMode | null;
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

export interface UpdateSessionBody {
  name?: string;
  priority?: number;
  color?: AnsiColor | null;
}

export async function updateSession(
  id: string,
  body: UpdateSessionBody
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(withQuery(`/api/sessions/${id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      return { ok: false, error: (await res.text()) || `Failed (${res.status})` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error." };
  }
}

export interface DeleteSessionResult {
  /**
   * True only when the server responded `200 { stillRunning: true }` — a
   * graceful kill whose daemon survived SIGTERM. False otherwise (including
   * cleanup-only deletes, successful kills, and network errors).
   */
  stillRunning: boolean;
}

export async function deleteSession(
  id: string,
  opts?: { kill?: "graceful" | "force" }
): Promise<DeleteSessionResult> {
  try {
    const params = new URLSearchParams(location.search);
    if (opts?.kill) {
      params.set("kill", opts.kill);
    }
    const query = params.toString();
    const path = `/api/sessions/${id}${query ? `?${query}` : ""}`;
    const res = await fetch(path, { method: "DELETE" });
    if (res.status === 200) {
      const data = (await res.json().catch(() => null)) as { stillRunning?: boolean } | null;
      return { stillRunning: data?.stillRunning === true };
    }
    return { stillRunning: false };
  } catch {
    // Best effort: the SSE stream will reconcile the list regardless.
    return { stillRunning: false };
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

export async function fetchHealth(): Promise<{ version: string | null; remotesEnabled: boolean }> {
  try {
    const res = await fetch(withQuery("/health"));
    if (!res.ok) {
      return { version: null, remotesEnabled: false };
    }
    const data = (await res.json()) as { version?: string; remotesEnabled?: boolean };
    return {
      version: typeof data.version === "string" ? data.version : null,
      remotesEnabled: data.remotesEnabled === true
    };
  } catch {
    return { version: null, remotesEnabled: false };
  }
}

export function attachSocketUrl(id: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/sessions/${id}/attach${location.search || ""}`;
}

export function isLiveStatus(status: SessionMeta["status"]): boolean {
  return status === "running" || status === "available" || status === "needs-attention";
}

export interface DashboardTunnelStatus {
  devtunnelAvailable: boolean;
  authenticated: boolean;
  running: boolean;
  url?: string;
  version?: string;
}

export async function fetchDashboardTunnelStatus(): Promise<DashboardTunnelStatus> {
  const res = await fetch(withQuery("/api/dashboard-tunnel/status"));
  if (!res.ok) {
    throw new Error(`Failed to load Tunnel Link status (${res.status})`);
  }
  return (await res.json()) as DashboardTunnelStatus;
}

export async function ensureDashboardTunnel(): Promise<DashboardTunnelStatus> {
  const res = await fetch(withQuery("/api/dashboard-tunnel"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  if (!res.ok) {
    throw new Error((await res.text()) || `Failed to start Tunnel Link (${res.status})`);
  }
  return (await res.json()) as DashboardTunnelStatus;
}

export async function closeDashboardTunnel(): Promise<void> {
  const res = await fetch(withQuery("/api/dashboard-tunnel"), {
    method: "DELETE",
    headers: { "content-type": "application/json" }
  });
  if (!res.ok) {
    throw new Error((await res.text()) || `Failed to close Tunnel Link (${res.status})`);
  }
}

export function attentionAckMessage(attentionMatchedAt: string): string {
  return JSON.stringify({ type: "attention", needsAttention: false, attentionMatchedAt });
}

export function canSendAttentionAck(
  attachedSessionId: string | null,
  targetSessionId: string,
  socketOpen: boolean
): boolean {
  return socketOpen && attachedSessionId === targetSessionId;
}

/**
 * Identifies when the terminal must tear down and re-establish its attachment.
 * Re-attaching is only required when the selected session changes, when it
 * crosses the live/terminated boundary (WebSocket vs. captured scrollback), or
 * when the terminal's visibility changes. It must NOT change on transitions
 * between live states (running <-> available <-> needs-attention),
 * which would otherwise reset the terminal and trigger a host-size revert/regrow
 * flicker on every idle toggle.
 */
export function attachKey(
  session: Pick<SessionMeta, "id" | "status"> | null | undefined,
  visible: boolean
): string {
  if (!session) {
    return "none";
  }
  return `${session.id}|${isLiveStatus(session.status) ? "live" : "term"}|${visible ? "1" : "0"}`;
}

export interface RemoteTunnelInfo {
  id: string;
  tokenExpiresAt?: string;
}

export interface RemoteStatus {
  devtunnelAvailable: boolean;
  version?: string;
  ingestPort: number;
  tunnel?: RemoteTunnelInfo;
  /** Present only in the response to a create/record action, never in GET status. */
  connectToken?: string;
  canHost: boolean;
}

export async function fetchRemoteStatus(): Promise<RemoteStatus> {
  const res = await fetch(withQuery("/api/remote/status"));
  if (!res.ok) {
    throw new Error(`Failed to load remote status (${res.status})`);
  }
  return (await res.json()) as RemoteStatus;
}

/** Auto-creates a dev tunnel on the home machine (requires the devtunnel CLI). */
export async function createRemoteTunnel(): Promise<RemoteStatus> {
  const res = await fetch(withQuery("/api/remote/tunnel"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "auto" })
  });
  if (!res.ok) {
    throw new Error((await res.text()) || `Failed to create tunnel (${res.status})`);
  }
  return (await res.json()) as RemoteStatus;
}

/** Records a manually-created tunnel (id or devtunnels.ms URL) plus its connect token. */
export async function recordManualTunnel(
  tunnelInput: string,
  connectToken: string
): Promise<RemoteStatus> {
  const res = await fetch(withQuery("/api/remote/tunnel"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "manual", tunnelInput, connectToken })
  });
  if (!res.ok) {
    throw new Error((await res.text()) || `Failed to record tunnel (${res.status})`);
  }
  return (await res.json()) as RemoteStatus;
}

export async function deleteRemoteTunnel(): Promise<void> {
  try {
    await fetch(withQuery("/api/remote/tunnel"), {
      method: "DELETE",
      headers: { "content-type": "application/json" }
    });
  } catch {
    // Best effort.
  }
}

export interface SetupScriptParams {
  tunnelId: string;
  connectToken: string;
  ingestPort: number;
  color?: AnsiColor | "none";
  priority?: number;
}

/** A single-quoted shell literal (handles embedded single quotes safely). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** True when a value contains characters that need shell quoting. */
function needsQuote(value: string): boolean {
  return !/^[A-Za-z0-9._\-:/]+$/.test(value);
}

function arg(value: string): string {
  return needsQuote(value) ? shellQuote(value) : value;
}

/**
 * Assembles the `climon config …` script a user runs on their devbox. Mirrors
 * the previous setup command but targets the dev-tunnel config keys. The script
 * is newline-joined so each setting is independently visible/copyable. Returns
 * guidance text (commented) when no tunnel id is available yet.
 */
export function buildSetupScript(params: SetupScriptParams): string {
  if (!params.tunnelId) {
    return "# Create or paste a dev tunnel above to generate the devbox config script.";
  }
  const lines = [
    "climon config remote.enabled true",
    `climon config remote.tunnelId ${arg(params.tunnelId)}`,
    `climon config remote.tunnelToken ${arg(params.connectToken)}`,
    `climon config remote.port ${params.ingestPort}`
  ];
  if (params.color) {
    lines.push(`climon config session.color ${params.color}`);
  }
  if (typeof params.priority === "number") {
    lines.push(`climon config session.priority ${params.priority}`);
  }
  return lines.join("\n");
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
