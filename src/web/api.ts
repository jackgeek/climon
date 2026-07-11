import type { AnsiColor, SessionColorMode, SessionMeta } from "../types.js";
import type { FeatureFlagState } from "../features.js";
import type { DevtunnelFailure, DevtunnelHealth, DevtunnelRetryState } from "../devtunnel/types.js";

type DevtunnelHealthState = DevtunnelHealth["state"];

const DEV_TUNNELS_HOST_SUFFIX = ".devtunnels.ms";
export const TUNNEL_SKIP_ANTI_PHISHING_PARAM = "X-Tunnel-Skip-AntiPhishing-Page";

interface DashboardLocationState {
  hostname: string;
  search: string;
}

interface AttachLocationState extends DashboardLocationState {
  protocol: string;
  host: string;
}

export function isDevTunnelHost(hostname: string): boolean {
  const normalized = hostname.replace(/\.$/, "").toLowerCase();
  return normalized === "devtunnels.ms" || normalized.endsWith(DEV_TUNNELS_HOST_SUFFIX);
}

function currentDashboardLocation(): DashboardLocationState {
  if (typeof location === "undefined") {
    return { hostname: "", search: "" };
  }
  return { hostname: location.hostname, search: location.search };
}

/**
 * Dev tunnels can show an anti-phishing interstitial on programmatic requests.
 * Browser WebSocket/EventSource cannot set the bypass header, but they can carry
 * the equivalent query parameter on same-origin dashboard URLs.
 */
export function withQuery(path: string, current: DashboardLocationState = currentDashboardLocation()): string {
  const params = new URLSearchParams(current.search);
  const devTunnelHost = isDevTunnelHost(current.hostname);
  if (!devTunnelHost && !params.has(TUNNEL_SKIP_ANTI_PHISHING_PARAM)) {
    return path;
  }
  if (devTunnelHost) {
    params.set(TUNNEL_SKIP_ANTI_PHISHING_PARAM, "true");
  }
  const query = params.toString();
  return query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path;
}

export type TunnelAuthState = "ok" | "auth-required" | "unreachable";

/**
 * Classifies a manual-redirect probe of the dashboard `/health` endpoint to tell
 * an expired dev-tunnel sign-in apart from a server outage. An expired session
 * makes the relay answer with a cross-origin 302 to a Microsoft login page,
 * which a `redirect: "manual"` fetch surfaces as an opaque-redirect response;
 * some relay configs serve the login page inline as `text/html` instead.
 */
export function classifyTunnelAuthResponse(res: Response): TunnelAuthState {
  if (res.type === "opaqueredirect") {
    return "auth-required";
  }
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (res.ok) {
    return contentType.includes("text/html") ? "auth-required" : "ok";
  }
  return "unreachable";
}

/**
 * Whether a tunnel-auth probe result should surface the in-app "Sign in again"
 * prompt. Only an expired/absent dev-tunnel sign-in (`auth-required`) prompts;
 * a transient outage (`unreachable`) or a healthy relay (`ok`) must not.
 */
export function shouldPromptTunnelReauth(state: TunnelAuthState): boolean {
  return state === "auth-required";
}

/**
 * Probes the tunnel relay to decide whether the dashboard connection dropped
 * because the Microsoft dev-tunnel sign-in expired. Only runs on dev-tunnel
 * hosts; everywhere else it is a no-op that reports `ok`. Network
 * failures report `unreachable` so a transient blip never triggers a sign-in
 * prompt.
 */
export async function probeTunnelAuth(
  opts: { isTunnelHost?: boolean; fetchImpl?: typeof fetch } = {}
): Promise<TunnelAuthState> {
  const isTunnelHost = opts.isTunnelHost ?? isDevTunnelHost(currentDashboardLocation().hostname);
  if (!isTunnelHost) {
    return "ok";
  }
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(withQuery("/health"), { redirect: "manual", cache: "no-store" });
    return classifyTunnelAuthResponse(res);
  } catch {
    return "unreachable";
  }
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
  /** Per-session terminal theme display name; omit to inherit the default. */
  theme?: string;
  /** When true, spawn the session headless (no GUI window). Default false (visible). */
  headless?: boolean;
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
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: data.id };
  } catch {
    return { ok: false, error: "Network error." };
  }
}

export interface UpdateSessionBody {
  name?: string;
  priority?: number;
  color?: AnsiColor | null;
  theme?: string;
  status?: Extract<SessionMeta["status"], "paused" | "running">;
}

export async function updateSession(
  id: string,
  body: UpdateSessionBody
): Promise<{ ok: boolean; session?: SessionMeta; error?: string }> {
  try {
    const res = await fetch(withQuery(`/api/sessions/${id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      return { ok: false, error: (await res.text()) || `Failed (${res.status})` };
    }
    const session = (await res.json()) as SessionMeta;
    return { ok: true, session };
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
    const params = new URLSearchParams();
    if (opts?.kill) {
      params.set("kill", opts.kill);
    }
    const query = params.toString();
    const path = withQuery(`/api/sessions/${id}${query ? `?${query}` : ""}`);
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

export async function fetchHealth(): Promise<{
  version: string | null;
  remotesEnabled: boolean;
  features: Record<string, FeatureFlagState>;
  focusTopSessionShortcut: string;
  preferences: Record<string, unknown>;
}> {
  try {
    const res = await fetch(withQuery("/health"));
    if (!res.ok) {
      return { version: null, remotesEnabled: false, features: {}, focusTopSessionShortcut: "Alt+J", preferences: {} };
    }
    const data = (await res.json()) as {
      version?: string;
      remotesEnabled?: boolean;
      features?: Record<string, FeatureFlagState>;
      shortcuts?: { focusTopSession?: string };
      preferences?: Record<string, unknown>;
    };
    const focusTopSessionShortcut =
      typeof data.shortcuts?.focusTopSession === "string" ? data.shortcuts.focusTopSession : "Alt+J";
    return {
      version: typeof data.version === "string" ? data.version : null,
      remotesEnabled: data.remotesEnabled === true,
      features: data.features && typeof data.features === "object" ? data.features : {},
      focusTopSessionShortcut,
      preferences: data.preferences && typeof data.preferences === "object" ? data.preferences : {}
    };
  } catch {
    return { version: null, remotesEnabled: false, features: {}, focusTopSessionShortcut: "Alt+J", preferences: {} };
  }
}

export async function probeHealthy(): Promise<boolean> {
  try {
    const res = await fetch(withQuery("/health"), { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

export function attachSocketUrl(id: string): string {
  return attachSocketUrlForLocation(id, location);
}

export function attachSocketUrlForLocation(id: string, current: AttachLocationState): string {
  const proto = current.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${current.host}${withQuery(`/api/sessions/${id}/attach`, current)}`;
}

export function isLiveStatus(status: SessionMeta["status"]): boolean {
  return status === "running" || status === "acknowledged" || status === "needs-attention" || status === "paused";
}

export interface DashboardTunnelStatus {
  devtunnelAvailable: boolean;
  authenticated: boolean;
  running: boolean;
  url?: string;
  tunnelId?: string;
  version?: string;
  expiresAt?: string;
  /** Structured mirror of `devtunnelAvailable` from the gateway health model. */
  available?: boolean;
  state?: DevtunnelHealthState;
  lastFailure?: DevtunnelFailure;
  retry?: DevtunnelRetryState;
}

/** Raised by the Tunnel Link client when a request returns a structured failure. */
export class DevtunnelApiError extends Error {
  constructor(public readonly failure: DevtunnelFailure) {
    super(failure.summary);
    this.name = "DevtunnelApiError";
  }
}

async function readDevtunnelResponse(res: Response): Promise<DashboardTunnelStatus> {
  const text = await res.text();
  let body: DashboardTunnelStatus | { error: DevtunnelFailure } | undefined;
  try {
    body = text ? (JSON.parse(text) as DashboardTunnelStatus | { error: DevtunnelFailure }) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const failure = (body as { error?: DevtunnelFailure } | undefined)?.error;
    throw new DevtunnelApiError(failure ?? unexpectedFailure(res, text));
  }
  return body as DashboardTunnelStatus;
}

/** Synthesizes a structured failure for a non-JSON error body (e.g. a guard 403). */
function unexpectedFailure(res: Response, text: string): DevtunnelFailure {
  return {
    code: "unknown",
    operation: "detect",
    summary: text.trim() || `Tunnel Link request failed (${res.status}).`,
    remediation: "Try again from the machine running the dashboard.",
    technicalDetail: `HTTP ${res.status}`,
    occurredAt: new Date().toISOString(),
    retryClass: "unknown",
    retryable: false
  };
}

export async function fetchDashboardTunnelStatus(): Promise<DashboardTunnelStatus> {
  const res = await fetch(withQuery("/api/dashboard-tunnel/status"));
  if (!res.ok) {
    throw new Error(`Failed to load Tunnel Link status (${res.status})`);
  }
  return (await res.json()) as DashboardTunnelStatus;
}

export async function ensureDashboardTunnel(): Promise<DashboardTunnelStatus> {
  return fetch(withQuery("/api/dashboard-tunnel"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  }).then(readDevtunnelResponse);
}

export function retryDashboardTunnel(): Promise<DashboardTunnelStatus> {
  return fetch(withQuery("/api/dashboard-tunnel/retry"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  }).then(readDevtunnelResponse);
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
 * between live states (running <-> acknowledged <-> needs-attention <-> paused),
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
}

export interface RemoteStatus {
  devtunnelAvailable: boolean;
  version?: string;
  /** Latest normalized gateway health, including any last ingest failure. */
  devtunnel: DevtunnelHealth;
  ingestPort: number;
  tunnel?: RemoteTunnelInfo;
  canHost: boolean;
  remoteSpawn?: boolean;
  spawnSecret?: string;
}

export async function fetchRemoteStatus(): Promise<RemoteStatus> {
  const res = await fetch(withQuery("/api/remote/status"));
  if (!res.ok) {
    throw new Error(`Failed to load remote status (${res.status})`);
  }
  return (await res.json()) as RemoteStatus;
}

/** Parses a remote-tunnel response, raising {@link DevtunnelApiError} on a structured failure. */
async function readRemoteStatusResponse(res: Response): Promise<RemoteStatus> {
  const text = await res.text();
  let body: RemoteStatus | { error: DevtunnelFailure } | undefined;
  try {
    body = text ? (JSON.parse(text) as RemoteStatus | { error: DevtunnelFailure }) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const failure = (body as { error?: DevtunnelFailure } | undefined)?.error;
    throw new DevtunnelApiError(failure ?? unexpectedFailure(res, text));
  }
  return body as RemoteStatus;
}

/** Re-runs ingest tunnel setup and returns the refreshed remote status. */
export function retryRemoteTunnel(): Promise<RemoteStatus> {
  return fetch(withQuery("/api/remote/tunnel/retry"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  }).then(readRemoteStatusResponse);
}

export interface SetupScriptParams {
  tunnelId: string;
  ingestPort: number;
  color?: SessionColorMode;
  priority?: number;
  clientId?: string;
  remoteSpawn?: boolean;
  spawnSecret?: string;
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
    return "# Enable host remotes to generate the devbox config script.";
  }
  const lines = [
    "climon config feature.remotes enabled",
    "climon config remote.enabled true",
    `climon config remote.tunnelId ${arg(params.tunnelId)}`
  ];
  if (params.clientId) {
    lines.push(`climon config remote.clientId ${arg(params.clientId)}`);
  }
  if (params.color) {
    lines.push(`climon config session.color ${params.color}`);
  }
  if (typeof params.priority === "number") {
    lines.push(`climon config session.priority ${params.priority}`);
  }
  if (params.remoteSpawn && params.spawnSecret) {
    lines.push("climon config feature.remoteSpawn enabled");
    lines.push(`climon config remote.spawnSecret ${arg(params.spawnSecret)}`);
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

export async function fetchVapidPublicKey(): Promise<string> {
  const res = await fetch(withQuery("/api/push/vapid-public-key"));
  if (!res.ok) {
    throw new Error(`Failed to load VAPID key (${res.status})`);
  }
  const data = (await res.json()) as { key?: string };
  if (!data.key) {
    throw new Error("Server returned no VAPID key");
  }
  return data.key;
}

export async function postPushSubscribe(subscription: PushSubscriptionJSON): Promise<void> {
  const res = await fetch(withQuery("/api/push/subscribe"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription)
  });
  if (!res.ok) {
    throw new Error(`Failed to subscribe to push (${res.status})`);
  }
}

export async function postPushUnsubscribe(endpoint: string): Promise<void> {
  const res = await fetch(withQuery("/api/push/unsubscribe"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint })
  });
  if (!res.ok) {
    throw new Error(`Failed to unsubscribe from push (${res.status})`);
  }
}

/**
 * Reports this device's foreground/background presence for a push subscription
 * so the server can skip sending an OS push to a device that is currently
 * viewing the dashboard. Best-effort: prefers `navigator.sendBeacon` (survives
 * page hide, e.g. reporting `foreground:false` on `visibilitychange`), and
 * falls back to a keepalive `fetch` when the beacon is unavailable or rejected.
 */
export function postPushPresence(endpoint: string, foreground: boolean): void {
  const url = withQuery("/api/push/presence");
  const payload = JSON.stringify({ endpoint, foreground });
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    const blob = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon(url, blob)) {
      return;
    }
  }
  void fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true
  }).catch(() => {});
}
