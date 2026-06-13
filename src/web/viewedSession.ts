import type { SessionMeta } from "../types.js";

/**
 * The session the user is actively viewing. Mirrors `TerminalView`'s
 * `terminalVisible` rule: an active session that exists in the list, the page
 * visible, and (on mobile) the terminal maximized.
 */
export function computeViewedSessionId(params: {
  activeId: string | null;
  sessions: SessionMeta[];
  pageVisible: boolean;
  isMobile: boolean;
  maximized: boolean;
}): string | null {
  const { activeId, sessions, pageVisible, isMobile, maximized } = params;
  if (activeId === null) return null;
  if (!sessions.some((s) => s.id === activeId)) return null;
  if (!pageVisible) return null;
  if (isMobile && !maximized) return null;
  return activeId;
}

export interface ViewedSessionAck {
  sessionId: string;
  attentionMatchedAt: string;
  key: string;
}

/**
 * Returns the attention acknowledgement to send for the viewed session, or null
 * when there is nothing to acknowledge or the same attention episode was already
 * acknowledged (deduped by `id:attentionMatchedAt`).
 */
export function viewedSessionAttentionAck(
  viewedSessionId: string | null,
  sessions: SessionMeta[],
  lastAckedKey: string | null
): ViewedSessionAck | null {
  if (!viewedSessionId) return null;
  const viewed = sessions.find((s) => s.id === viewedSessionId);
  if (!viewed || viewed.status !== "needs-attention" || !viewed.attentionMatchedAt) return null;
  const key = `${viewed.id}:${viewed.attentionMatchedAt}`;
  if (key === lastAckedKey) return null;
  return { sessionId: viewed.id, attentionMatchedAt: viewed.attentionMatchedAt, key };
}
