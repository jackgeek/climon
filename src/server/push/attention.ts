import type { SessionMeta } from "../../types.js";
import { notificationBody, notificationTitle } from "../../notification-content.js";

export interface PushPayload {
  title: string;
  body: string;
  sessionId: string;
  key: string;
}

export interface AttentionTracker {
  update: (sessions: SessionMeta[]) => SessionMeta[];
}

function attentionStateKey(session: Pick<SessionMeta, "id" | "attentionMatchedAt">): string {
  return `${session.id}:${session.attentionMatchedAt ?? "attention"}`;
}

export function buildPushPayload(session: SessionMeta): PushPayload {
  return {
    title: notificationTitle(session),
    body: notificationBody(session),
    sessionId: session.id,
    key: attentionStateKey(session)
  };
}

export function createAttentionTracker(): AttentionTracker {
  const seen = new Set<string>();
  let seeded = false;

  function update(sessions: SessionMeta[]): SessionMeta[] {
    const attentive = sessions.filter((s) => s.status === "needs-attention");
    const newly = attentive.filter((s) => !seen.has(attentionStateKey(s)));

    seen.clear();
    for (const s of attentive) seen.add(attentionStateKey(s));

    if (!seeded) {
      seeded = true;
      return [];
    }
    return newly;
  }

  return { update };
}
