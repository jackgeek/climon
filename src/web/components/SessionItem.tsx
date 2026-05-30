import { Button, Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { Dismiss16Regular, Add16Regular } from "@fluentui/react-icons";
import type { SessionMeta } from "../../types.js";
import { StatusBadge } from "./StatusBadge.js";

const useStyles = makeStyles({
  root: {
    position: "relative",
    padding: "12px 16px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: "pointer",
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
    ":hover .climon-close": { display: "inline-flex" },
    ":hover .climon-new": { display: "inline-flex" }
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
  id: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: "11px",
    color: tokens.colorNeutralForeground3
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
  }
});

interface Props {
  session: SessionMeta;
  active: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: (session: SessionMeta) => void;
}

export function SessionItem({ session, active, onSelect, onClose, onNew }: Props) {
  const styles = useStyles();
  return (
    <div
      className={mergeClasses(styles.root, active && styles.active)}
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
      {["running", "needs-attention", "disconnected"].includes(session.status) && (
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
      <Button
        className={mergeClasses("climon-close", styles.close)}
        appearance="subtle"
        size="small"
        icon={<Dismiss16Regular />}
        title="Clean up session"
        aria-label="Clean up session"
        onClick={(e) => {
          e.stopPropagation();
          onClose(session.id);
        }}
      />
      <Text className={styles.cmd} title={session.displayCommand}>
        {session.displayCommand}
      </Text>
      <div className={styles.meta}>
        <StatusBadge status={session.status} />
        <span className={styles.id}>{session.id}</span>
        {session.origin === "remote" && (
          <span className={styles.origin} title={session.clientLabel ?? "remote"}>
            {session.clientLabel ?? "remote"}
          </span>
        )}
      </div>
    </div>
  );
}
