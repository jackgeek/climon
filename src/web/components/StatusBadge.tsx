import { Badge } from "@fluentui/react-components";
import type { SessionStatus } from "../../types.js";

const COLOR: Record<SessionStatus, "informative" | "warning" | "success" | "danger" | "subtle"> = {
  running: "informative",
  "needs-attention": "warning",
  completed: "success",
  failed: "danger",
  disconnected: "subtle"
};

export const STATUS_LABELS: Record<SessionStatus, string> = {
  running: "running",
  "needs-attention": "needs attention",
  completed: "completed",
  failed: "failed",
  disconnected: "disconnected"
};

export const STATUS_INITIALS: Record<SessionStatus, string> = {
  running: "R",
  "needs-attention": "NA",
  completed: "C",
  failed: "F",
  disconnected: "D"
};

interface Props {
  status: SessionStatus;
  compact?: boolean;
}

export function StatusBadge({ status, compact = false }: Props) {
  return (
    <Badge appearance="filled" color={COLOR[status]} size="small" title={STATUS_LABELS[status]}>
      {compact ? STATUS_INITIALS[status] : STATUS_LABELS[status]}
    </Badge>
  );
}
