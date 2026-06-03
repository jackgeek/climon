import type { SessionMeta } from "./types.js";
import { DEFAULT_PRIORITY } from "./session-meta.js";

const rank: Record<SessionMeta["status"], number> = {
  "needs-attention": 0,
  available: 1,
  running: 2,
  completed: 3,
  failed: 4,
  disconnected: 5
};

function timestamp(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}

function priorityOf(session: SessionMeta): number {
  return typeof session.priority === "number" ? session.priority : DEFAULT_PRIORITY;
}

export function sortSessionsByPriority(sessions: SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((left, right) => {
    const rankDiff = rank[left.status] - rank[right.status];
    if (rankDiff !== 0) {
      return rankDiff;
    }
    const priorityDiff = priorityOf(left) - priorityOf(right);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    return timestamp(right.updatedAt) - timestamp(left.updatedAt);
  });
}
