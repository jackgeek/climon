import { Badge } from "@fluentui/react-components";
import type { SessionStatus } from "../../types.js";

type BadgeColor = "brand" | "informative" | "warning" | "success" | "danger" | "subtle";

const COLOR: Record<SessionStatus, BadgeColor> = {
  running: "brand",
  acknowledged: "success",
  "needs-attention": "warning",
  completed: "success",
  paused: "subtle",
  failed: "danger",
  disconnected: "subtle"
};

export function statusBadgeColor(status: SessionStatus): BadgeColor {
  return COLOR[status];
}

export const STATUS_LABELS: Record<SessionStatus, string> = {
  running: "running",
  acknowledged: "acknowledged",
  "needs-attention": "needs attention",
  completed: "completed",
  paused: "paused",
  failed: "failed",
  disconnected: "disconnected"
};

export const STATUS_INITIALS: Record<SessionStatus, string> = {
  running: "R",
  acknowledged: "A",
  "needs-attention": "NA",
  completed: "C",
  paused: "P",
  failed: "F",
  disconnected: "D"
};

interface Props {
  status: SessionStatus;
  compact?: boolean;
  showTitle?: boolean;
}

export function StatusBadge({ status, compact = false, showTitle = true }: Props) {
  return (
    <Badge
      appearance="filled"
      color={statusBadgeColor(status)}
      size="small"
      title={showTitle ? STATUS_LABELS[status] : undefined}
    >
      {compact ? STATUS_INITIALS[status] : STATUS_LABELS[status]}
    </Badge>
  );
}
