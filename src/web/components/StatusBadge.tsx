import { Badge, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import type { SessionStatus } from "../../types.js";

const useStyles = makeStyles({
  completed: {
    backgroundColor: tokens.colorPaletteDarkGreenBackground2,
    borderTopColor: tokens.colorPaletteDarkGreenBackground2,
    borderRightColor: tokens.colorPaletteDarkGreenBackground2,
    borderBottomColor: tokens.colorPaletteDarkGreenBackground2,
    borderLeftColor: tokens.colorPaletteDarkGreenBackground2,
    color: tokens.colorNeutralForegroundOnBrand
  }
});

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
  const styles = useStyles();
  return (
    <Badge
      appearance="filled"
      color={statusBadgeColor(status)}
      className={status === "completed" ? mergeClasses(styles.completed) : undefined}
      size="small"
      title={showTitle ? STATUS_LABELS[status] : undefined}
    >
      {compact ? STATUS_INITIALS[status] : STATUS_LABELS[status]}
    </Badge>
  );
}
