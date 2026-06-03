import { Badge } from "@fluentui/react-components";
import type { SessionStatus } from "../../types.js";

type BadgeColor = "brand" | "informative" | "warning" | "success" | "danger" | "subtle";

const COLOR: Record<SessionStatus, BadgeColor> = {
  running: "brand",
  available: "success",
  "needs-attention": "warning",
  completed: "success",
  failed: "danger",
  disconnected: "subtle"
};

export function statusBadgeColor(status: SessionStatus): BadgeColor {
  return COLOR[status];
}

const LABEL: Record<SessionStatus, string> = {
  running: "running",
  available: "available",
  "needs-attention": "needs attention",
  completed: "completed",
  failed: "failed",
  disconnected: "disconnected"
};

export function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <Badge appearance="filled" color={statusBadgeColor(status)} size="small">
      {LABEL[status]}
    </Badge>
  );
}
