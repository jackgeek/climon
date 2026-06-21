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
import { useEffect, useRef } from "react";
import type { SessionMeta } from "../../types.js";
import type { TerminalResizeMode } from "../../ipc/frame.js";
import type { DashboardTunnelStatus } from "../api.js";
import { SessionItem } from "./SessionItem.js";
import { useFeature } from "../hooks/useFeature.js";
import { useAnimatedListReorder } from "../hooks/useAnimatedListReorder.js";
import { DASHBOARD_HEADER_HEIGHT } from "../layout.js";
import {
  getStableSessionItemRef,
  installPwaMenuLabel,
  keyBarPinnedMenuLabel,
  notificationsMenuLabel,
  removeDisconnectedMenuLabel,
  remotesMenuLabel,
  scrollActiveSessionIntoView,
  type StableSessionItemRefRegistry
} from "../sidebar-utils.js";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    height: "100%",
    overflow: "hidden"
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
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
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
    flex: "1 1 auto",
    minHeight: 0,
    direction: "rtl"
  },
  listItem: {
    direction: "ltr"
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
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: "16px"
  },
  footer: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "6px 8px",
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`
  },
  collapsedFooter: {
    justifyContent: "center"
  }
});

export const tunnelLinkMenuLabel = "Tunnel Link";
export const closeTunnelLinkMenuLabel = "Close Tunnel Link";

export function shouldShowTunnelLink(status: Pick<DashboardTunnelStatus, "devtunnelAvailable"> | null): boolean {
  return status?.devtunnelAvailable === true;
}

export function shouldShowCloseTunnelLink(
  status: Pick<DashboardTunnelStatus, "devtunnelAvailable" | "running"> | null
): boolean {
  return status?.devtunnelAvailable === true && status.running === true;
}

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
  notificationsEnabled: boolean;
  onToggleNotifications: () => void;
  canInstallPwa: boolean;
  onInstallPwa: () => void;
  tunnelLinkStatus: DashboardTunnelStatus | null;
  onTunnelLink: () => void;
  onCloseTunnelLink: () => void;
  showRemotesMenu?: boolean;
  onRemoveDisconnected: () => void;
  viewMode: TerminalResizeMode;
  viewModeLocked?: boolean;
  onViewModeToggle?: () => void;
  onMaximize: (id: string) => void;
  isMobile: boolean;
  keyBarPinned: boolean;
  onToggleKeyBarPinned: () => void;
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
  notificationsEnabled,
  onToggleNotifications,
  canInstallPwa,
  onInstallPwa,
  tunnelLinkStatus,
  onTunnelLink,
  onCloseTunnelLink,
  showRemotesMenu = false,
  onRemoveDisconnected,
  viewMode,
  viewModeLocked = false,
  onViewModeToggle,
  onMaximize,
  isMobile,
  keyBarPinned,
  onToggleKeyBarPinned,
}: Props) {
  const styles = useStyles();
  const sessionSpawning = useFeature("sessionSpawning").enabled;
  const animatedList = useAnimatedListReorder(sessions.map((session) => session.id));
  const itemRefRegistry = useRef<StableSessionItemRefRegistry>({ refs: {}, animatedRefs: {}, elements: {} });

  useEffect(() => {
    scrollActiveSessionIntoView(activeId, (id) => itemRefRegistry.current.elements[id]);
  }, [activeId, sessions]);

  return (
    <div className={mergeClasses(styles.root, collapsed && styles.collapsedRoot)}>
      <div className={mergeClasses(styles.header, collapsed && styles.collapsedHeader)}>
        <div className={styles.headerLeft}>
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
                <MenuItem onClick={onToggleNotifications}>{notificationsMenuLabel(notificationsEnabled)}</MenuItem>
                {isMobile && (
                  <MenuItem onClick={onToggleKeyBarPinned}>{keyBarPinnedMenuLabel(keyBarPinned)}</MenuItem>
                )}
                {canInstallPwa && (
                  <MenuItem onClick={onInstallPwa}>{installPwaMenuLabel}</MenuItem>
                )}
                {shouldShowTunnelLink(tunnelLinkStatus) && (
                  <MenuItem onClick={onTunnelLink}>{tunnelLinkMenuLabel}</MenuItem>
                )}
                {shouldShowCloseTunnelLink(tunnelLinkStatus) && (
                  <MenuItem onClick={onCloseTunnelLink}>{closeTunnelLinkMenuLabel}</MenuItem>
                )}
                {showRemotesMenu && <MenuItem onClick={onManageRemote}>{remotesMenuLabel}</MenuItem>}
                {sessions.some((s) => s.status === "completed" || s.status === "failed" || s.status === "disconnected") && (
                  <MenuItem onClick={onRemoveDisconnected}>{removeDisconnectedMenuLabel}</MenuItem>
                )}
              </MenuList>
            </MenuPopover>
          </Menu>
          <Text className={mergeClasses(styles.title, collapsed && styles.hiddenTitle)}>
            climon
            {serverVersion && <span className={styles.version}>v{serverVersion}</span>}
          </Text>
        </div>
        {!collapsed && sessionSpawning && (
          <Button
            appearance="subtle"
            icon={<Add20Regular />}
            title="New session"
            aria-label="New session"
            onClick={onNew}
          />
        )}
      </div>
      <div className={styles.list} dir="rtl">
        {sessions.length === 0 ? (
          <div className={mergeClasses(styles.empty, collapsed && styles.collapsedEmpty)} dir="ltr">
            {collapsed ? "No sessions" : "No sessions yet."}
          </div>
        ) : (
          sessions.map((s) => {
            const registerItem = getStableSessionItemRef(
              itemRefRegistry.current,
              s.id,
              animatedList.registerItem
            );
            return (
              <div
                key={s.id}
                className={styles.listItem}
                dir="ltr"
                ref={registerItem}
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
                  viewMode={viewMode}
                  viewModeLocked={viewModeLocked}
                  onViewModeToggle={onViewModeToggle}
                />
              </div>
            );
          })
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
