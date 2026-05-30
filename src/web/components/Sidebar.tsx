import {
  Button,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  makeStyles,
  tokens
} from "@fluentui/react-components";
import { Add20Regular, Navigation20Regular } from "@fluentui/react-icons";
import type { SessionMeta } from "../../types.js";
import { SessionItem } from "./SessionItem.js";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    height: "100%"
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    flex: "0 0 auto"
  },
  title: {
    fontSize: "16px",
    fontWeight: tokens.fontWeightSemibold
  },
  version: {
    marginLeft: "6px",
    fontSize: "11px",
    fontWeight: tokens.fontWeightRegular,
    color: tokens.colorNeutralForeground3
  },
  list: {
    overflowY: "auto",
    flex: "1 1 auto"
  },
  empty: {
    padding: "16px",
    color: tokens.colorNeutralForeground3,
    fontSize: "13px"
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: "4px"
  }
});

interface Props {
  sessions: SessionMeta[];
  activeId: string | null;
  serverVersion?: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onNewFrom: (session: SessionMeta) => void;
  onManageRemote: () => void;
  onMaximize: (id: string) => void;
}

export function Sidebar({ sessions, activeId, serverVersion, onSelect, onClose, onNew, onNewFrom, onManageRemote, onMaximize }: Props) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Text className={styles.title}>
          climon
          {serverVersion && <span className={styles.version}>v{serverVersion}</span>}
        </Text>
        <div className={styles.actions}>
          {sessions.length === 0 && (
            <Button
              appearance="subtle"
              icon={<Add20Regular />}
              title="New session"
              aria-label="New session"
              onClick={onNew}
            />
          )}
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button
                appearance="subtle"
                icon={<Navigation20Regular />}
                title="Menu"
                aria-label="Menu"
              />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem onClick={onManageRemote}>Remote clients…</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      </div>
      <div className={styles.list}>
        {sessions.length === 0 ? (
          <div className={styles.empty}>No sessions yet.</div>
        ) : (
          sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              active={s.id === activeId}
              onSelect={onSelect}
              onClose={onClose}
              onNew={onNewFrom}
              onMaximize={onMaximize}
            />
          ))
        )}
      </div>
    </div>
  );
}
