import { Badge } from "@fluentui/react-components";
import type { SessionStatus } from "../../types.js";

const COLOR: Record<SessionStatus, "informative" | "warning" | "success" | "danger" | "subtle"> = {
  running: "informative",
  available: "success",
  "needs-attention": "warning",
  completed: "success",
  failed: "danger",
  disconnected: "subtle"
};

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
    <Badge appearance="filled" color={COLOR[status]} size="small">
      {LABEL[status]}
    </Badge>
  );
}
