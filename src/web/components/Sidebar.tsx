import {
  Button,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  makeStyles,
  mergeClasses,
  tokens
} from "@fluentui/react-components";
import {
  Add20Regular,
  ChevronDoubleLeftRegular,
  ChevronDoubleRightRegular,
  Navigation20Regular
} from "@fluentui/react-icons";
import type { SessionMeta } from "../../types.js";
import type { TerminalResizeMode } from "../../ipc/frame.js";
import { SessionItem } from "./SessionItem.js";
import { useAnimatedListReorder } from "../hooks/useAnimatedListReorder.js";
import { clampSizeMenuLabel, toggleViewMode } from "../view-mode.js";
import { DASHBOARD_HEADER_HEIGHT } from "../layout.js";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    height: "100%"
  },
  collapsedRoot: {
    width: "64px"
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    boxSizing: "border-box",
    height: DASHBOARD_HEADER_HEIGHT,
    padding: "4px 16px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    flex: "0 0 auto"
  },
  collapsedHeader: {
    justifyContent: "center",
    padding: "4px 8px"
  },
  title: {
    fontSize: "16px",
    fontWeight: tokens.fontWeightSemibold
  },
  hiddenTitle: {
    display: "none"
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
  collapsedEmpty: {
    padding: "12px 4px",
    textAlign: "center",
    fontSize: "11px"
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: "4px"
  },
  footer: {
    flex: "0 0 auto",
    display: "flex",
    justifyContent: "flex-end",
    padding: "6px 8px",
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`
  },
  collapsedFooter: {
    justifyContent: "center"
  }
});

export const remotesMenuLabel = "Remotes (experimental)…";

interface Props {
  sessions: SessionMeta[];
  activeId: string | null;
  serverVersion?: string | null;
  collapsed: boolean;
  collapsible: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onNewFrom: (session: SessionMeta) => void;
  onEdit: (session: SessionMeta) => void;
  onPauseToggle: (session: SessionMeta) => void;
  onManageRemote: () => void;
  viewMode: TerminalResizeMode;
  onViewModeChange: (mode: TerminalResizeMode) => void;
  onMaximize: (id: string) => void;
}

export function Sidebar({
  sessions,
  activeId,
  serverVersion,
  collapsed,
  collapsible,
  onCollapsedChange,
  onSelect,
  onClose,
  onNew,
  onNewFrom,
  onEdit,
  onPauseToggle,
  onManageRemote,
  viewMode,
  onViewModeChange,
  onMaximize
}: Props) {
  const styles = useStyles();
  const animatedList = useAnimatedListReorder(sessions.map((session) => session.id));
  return (
    <div className={mergeClasses(styles.root, collapsed && styles.collapsedRoot)}>
      <div className={mergeClasses(styles.header, collapsed && styles.collapsedHeader)}>
        <Text className={mergeClasses(styles.title, collapsed && styles.hiddenTitle)}>
          climon
          {serverVersion && <span className={styles.version}>v{serverVersion}</span>}
        </Text>
        <div className={styles.actions}>
          {sessions.length === 0 && !collapsed && (
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
                <MenuItem onClick={() => onViewModeChange(toggleViewMode(viewMode))}>
                  {viewMode === "clamped" ? "✓ " : ""}
                  {clampSizeMenuLabel}
                </MenuItem>
                <MenuItem onClick={onManageRemote}>{remotesMenuLabel}</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      </div>
      <div className={styles.list}>
        {sessions.length === 0 ? (
          <div className={mergeClasses(styles.empty, collapsed && styles.collapsedEmpty)}>
            {collapsed ? "No sessions" : "No sessions yet."}
          </div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              ref={animatedList.registerItem(s.id)}
              style={animatedList.getItemStyle(s.id)}
            >
              <SessionItem
                session={s}
                active={s.id === activeId}
                compact={collapsed}
                onSelect={onSelect}
                onClose={onClose}
                onNew={onNewFrom}
                onEdit={onEdit}
                onPauseToggle={onPauseToggle}
                onMaximize={onMaximize}
              />
            </div>
          ))
        )}
      </div>
      {collapsible && (
        <div className={mergeClasses(styles.footer, collapsed && styles.collapsedFooter)}>
          <Button
            appearance="subtle"
            size="small"
            icon={collapsed ? <ChevronDoubleRightRegular /> : <ChevronDoubleLeftRegular />}
            title={collapsed ? "Expand session list" : "Collapse session list"}
            aria-label={collapsed ? "Expand session list" : "Collapse session list"}
            onClick={() => onCollapsedChange(!collapsed)}
          />
        </div>
      )}
    </div>
  );
}
