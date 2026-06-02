import type { SessionMeta } from "../types.js";
import type { AnsiColor } from "../types.js";

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
  color?: AnsiColor | null;
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

export async function fetchHealth(): Promise<{ version: string | null }> {
  try {
    const res = await fetch(withQuery("/health"));
    if (!res.ok) {
      return { version: null };
    }
    const data = (await res.json()) as { version?: string };
    return { version: typeof data.version === "string" ? data.version : null };
  } catch {
    return { version: null };
  }
}

export function attachSocketUrl(id: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/sessions/${id}/attach${location.search || ""}`;
}

export function isLiveStatus(status: SessionMeta["status"]): boolean {
  return status === "running" || status === "needs-attention";
}

/**
 * Identifies when the terminal must tear down and re-establish its attachment.
 * Re-attaching is only required when the selected session changes, when it
 * crosses the live/terminated boundary (WebSocket vs. captured scrollback), or
 * when the terminal's visibility changes. It must NOT change on transitions
 * between two live states (running <-> needs-attention from idle detection),
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

export interface RemoteSetup {
  user: string;
  sshPort: number;
  hosts: string[];
  hostKey: string;
}

export interface RemoteClient {
  label: string;
  keyType: string;
  fingerprint: string;
}

export async function fetchRemoteSetup(): Promise<RemoteSetup> {
  const res = await fetch(withQuery("/api/remote/setup"));
  if (!res.ok) {
    throw new Error(`Failed to load setup (${res.status})`);
  }
  return (await res.json()) as RemoteSetup;
}

export async function fetchRemoteClients(): Promise<RemoteClient[]> {
  const res = await fetch(withQuery("/api/remote/clients"));
  if (!res.ok) {
    throw new Error(`Failed to load clients (${res.status})`);
  }
  const data = (await res.json()) as { clients?: RemoteClient[] };
  return data.clients ?? [];
}

export async function addRemoteClient(label: string, publicKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(withQuery("/api/remote/clients"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, publicKey })
    });
    if (!res.ok) {
      return { ok: false, error: (await res.text()) || `Failed (${res.status})` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error." };
  }
}

export async function deleteRemoteClient(label: string): Promise<void> {
  try {
    await fetch(withQuery(`/api/remote/clients/${encodeURIComponent(label)}`), {
      method: "DELETE",
      headers: { "content-type": "application/json" }
    });
  } catch {
    // Best effort.
  }
}

export type IpFamily = "ipv4" | "ipv6";

/** Classifies a host string by IP family; non-IP values (e.g. a hostname) are "hostname". */
function hostFamily(host: string): IpFamily | "hostname" {
  if (host.includes(":")) return "ipv6";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return "ipv4";
  return "hostname";
}

/**
 * Builds the one-line bash command a user pastes on a devbox. It generates a
 * client keypair (if missing), pins the home host key into the project
 * known_hosts, and records the connection config via `climon config`. The user
 * still pastes the printed public key back into the dashboard to authorize it —
 * no secret ever leaves the devbox.
 *
 * `family` selects which advertised address to connect to (IPv6 by default).
 * The pinned known_hosts line is anchored to the same address so host-key
 * verification (StrictHostKeyChecking=yes) stays consistent.
 */
export function buildSetupCommand(setup: RemoteSetup, family: IpFamily = "ipv6"): string {
  const host = setup.hosts.find((h) => hostFamily(h) === family);
  if (!host) {
    const label = family === "ipv6" ? "IPv6" : "IPv4";
    return `# No reachable ${label} address detected on the server. Set one manually with: climon config remote.host <ip-address>`;
  }
  const lines = [
    "climon config remote.enabled true",
    `climon config remote.host ${host}`,
    `climon config remote.user ${setup.user}`,
    `climon config remote.port ${setup.sshPort}`
  ];
  if (setup.hostKey) {
    lines.push(`climon config known-host '${host} ${setup.hostKey.replace(/'/g, "")}'`);
  }
  lines.push("climon config keygen");
  return lines.join(" && ");
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
