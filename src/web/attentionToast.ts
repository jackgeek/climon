import type { SessionMeta } from "../types.js";
import { attentionStateKey, sessionAttentionLabel } from "./attentionAlerts.js";

/** A subtle in-app attention toast shown while the dashboard is in the foreground. */
export interface AttentionToast {
  /** Stable per-attention-episode id so one episode yields at most one toast. */
  toastId: string;
  /** Human-readable title, e.g. "API server needs attention". */
  message: string;
  /** Optional subtitle: the session's terminal title (OSC 0/2), when present. */
  body?: string;
  /** The session to open when the toast is tapped. */
  sessionId: string;
}

/**
 * Builds the in-app attention toast for a session. Unlike the OS-level push
 * notification (which is shown out-of-app), the in-app toast is deliberately
 * terse. The body mirrors the push body: the session's terminal title.
 */
export function buildAttentionToast(session: SessionMeta): AttentionToast {
  const terminalTitle = session.terminalTitle?.trim();
  return {
    toastId: attentionStateKey(session),
    message: `${sessionAttentionLabel(session)} needs attention`,
    body: terminalTitle ? terminalTitle : undefined,
    sessionId: session.id
  };
}
