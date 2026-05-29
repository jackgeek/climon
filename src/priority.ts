import type { SessionMeta } from "./types.js";

const rank: Record<SessionMeta["status"], number> = {
  "needs-attention": 0,
  running: 1,
  completed: 2,
  failed: 2,
  disconnected: 3
};

function timestamp(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}

export function sortSessionsByPriority(sessions: SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((left, right) => {
    const rankDiff = rank[left.status] - rank[right.status];
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return timestamp(right.updatedAt) - timestamp(left.updatedAt);
  });
}
