import { Button, Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { Dismiss16Regular, Add16Regular, FullScreenMaximize16Regular, Settings16Regular } from "@fluentui/react-icons";
import { ANSI_CSS } from "../colors.js";
import type { SessionMeta } from "../../types.js";
import { StatusBadge, STATUS_LABELS } from "./StatusBadge.js";

const useStyles = makeStyles({
  root: {
    position: "relative",
    padding: "12px 16px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: "pointer",
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
    ":hover .climon-close": { display: "inline-flex" },
    ":hover .climon-new": { display: "inline-flex" },
    ":hover .climon-edit": { display: "inline-flex" }
  },
  compactRoot: {
    minHeight: "54px",
    padding: "8px 0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box"
  },
  active: {
    backgroundColor: tokens.colorNeutralBackground1Selected
  },
  cmd: {
    display: "block",
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: "13px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    paddingRight: "20px"
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    marginTop: "6px",
    fontSize: "11px",
    color: tokens.colorNeutralForeground3
  },
  compactMeta: {
    justifyContent: "center",
    marginTop: 0,
    gap: 0
  },
  origin: {
    fontSize: "10px",
    padding: "1px 6px",
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2
  },
  close: {
    position: "absolute",
    top: "8px",
    right: "8px",
    display: "none"
  },
  newBtn: {
    position: "absolute",
    top: "8px",
    right: "36px",
    display: "none"
  },
  editBtn: {
    position: "absolute",
    top: "8px",
    right: "64px",
    display: "none"
  },
  maximize: {
    display: "none",
    marginTop: "8px",
    width: "100%",
    "@media (max-width: 768px)": {
      display: "inline-flex"
    }
  }
});

interface Props {
  session: SessionMeta;
  active: boolean;
  compact?: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: (session: SessionMeta) => void;
  onEdit: (session: SessionMeta) => void;
  onMaximize: (id: string) => void;
}

export function sessionDisplayTitle(session: Pick<SessionMeta, "name" | "displayCommand">): string {
  return session.name || session.displayCommand;
}

export function sessionAccessibleLabel(
  session: Pick<SessionMeta, "name" | "displayCommand" | "status">,
  compact: boolean
): string | undefined {
  if (!compact) {
    return undefined;
  }
  return `${sessionDisplayTitle(session)}, ${STATUS_LABELS[session.status]}`;
}

export function SessionItem({
  session,
  active,
  compact = false,
  onSelect,
  onClose,
  onNew,
  onEdit,
  onMaximize
}: Props) {
  const styles = useStyles();
  const displayTitle = sessionDisplayTitle(session);
  return (
    <div
      className={mergeClasses(styles.root, compact && styles.compactRoot, active && styles.active)}
      style={session.color ? { borderRight: `4px solid ${ANSI_CSS[session.color]}` } : undefined}
      title={displayTitle}
      aria-label={sessionAccessibleLabel(session, compact)}
      onClick={() => onSelect(session.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(session.id);
        }
      }}
    >
      {!compact && ["running", "needs-attention", "disconnected"].includes(session.status) && (
        <Button
          className={mergeClasses("climon-new", styles.newBtn)}
          appearance="subtle"
          size="small"
          icon={<Add16Regular />}
          title="New session from here"
          aria-label="New session from here"
          onClick={(e) => {
            e.stopPropagation();
            onNew(session);
          }}
        />
      )}
      {!compact && (
        <Button
          className={mergeClasses("climon-edit", styles.editBtn)}
          appearance="subtle"
          size="small"
          icon={<Settings16Regular />}
          title="Edit session"
          aria-label="Edit session"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(session);
          }}
        />
      )}
      {!compact && (
        <Button
          className={mergeClasses("climon-close", styles.close)}
          appearance="subtle"
          size="small"
          icon={<Dismiss16Regular />}
          title="Close session"
          aria-label="Close session"
          onClick={(e) => {
            e.stopPropagation();
            onClose(session.id);
          }}
        />
      )}
      {!compact && (
        <Text className={styles.cmd} title={session.displayCommand}>
          {displayTitle}
        </Text>
      )}
      <div className={mergeClasses(styles.meta, compact && styles.compactMeta)}>
        <StatusBadge status={session.status} compact={compact} />
        {!compact && session.origin === "remote" && (
          <span className={styles.origin} title={session.clientLabel ?? "remote"}>
            {session.clientLabel ?? "remote"}
          </span>
        )}
      </div>
      {active && !compact && (
        <Button
          className={styles.maximize}
          appearance="primary"
          size="small"
          icon={<FullScreenMaximize16Regular />}
          onClick={(e) => {
            e.stopPropagation();
            onMaximize(session.id);
          }}
        >
          Open terminal
        </Button>
      )}
    </div>
  );
}
