import type { SessionMeta } from "../types.js";
import { attentionStateKey, sessionAttentionLabel } from "./attentionAlerts.js";

/** A subtle in-app attention toast shown while the dashboard is in the foreground. */
export interface AttentionToast {
  /** Stable per-attention-episode id so one episode yields at most one toast. */
  toastId: string;
  /** Human-readable message, e.g. "API server needs attention". */
  message: string;
  /** The session to open when the toast is tapped. */
  sessionId: string;
}

/**
 * Builds the in-app attention toast for a session. Unlike the OS-level push
 * notification (which is prefixed with "climon" for out-of-app context), the
 * in-app toast is deliberately terse: the user is already in climon.
 */
export function buildAttentionToast(session: SessionMeta): AttentionToast {
  return {
    toastId: attentionStateKey(session),
    message: `${sessionAttentionLabel(session)} needs attention`,
    sessionId: session.id
  };
}
