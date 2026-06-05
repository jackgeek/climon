import { useEffect, useRef, useState, useCallback } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text,
  makeStyles,
  mergeClasses,
  tokens
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import type { SessionMeta } from "../types.js";
import {
  eventsUrl,
  fetchSessions,
  deleteSession,
  fetchHealth,
  isLiveStatus,
  updateSession,
  closeDashboardTunnel,
  ensureDashboardTunnel,
  fetchDashboardTunnelStatus,
  type DashboardTunnelStatus
} from "./api.js";
import { Sidebar } from "./components/Sidebar.js";
import { NewSessionDialog } from "./components/NewSessionDialog.js";
import { EditSessionDialog } from "./components/EditSessionDialog.js";
import { CloseSessionDialog, ForceKillDialog } from "./components/CloseSessionDialog.js";
import { RemoteClientDialog } from "./components/RemoteClientDialog.js";
import { TunnelLinkDialog } from "./components/TunnelLinkDialog.js";
import { TerminalView, type TerminalHandle } from "./components/TerminalView.js";
import { KeyBar } from "./components/KeyBar.js";
import { DASHBOARD_HEADER_HEIGHT } from "./layout.js";
import { effectiveSidebarCollapsed, readSidebarCollapsed, writeSidebarCollapsed } from "./sidebarCollapse.js";
import { SplashScreen } from "./components/SplashScreen.js";
import {
  browserNotificationPermissionMessage,
  browserNotificationPermissionFailureTitle,
  notificationsEnabledFromState,
  readBrowserNotificationsEnabled,
  requestBrowserNotificationPermission,
  useAttentionAlerts,
  writeBrowserNotificationsEnabled
} from "./attentionAlerts.js";
import { StatusBadge } from "./components/StatusBadge.js";
import type { TerminalResizeMode } from "../ipc/frame.js";
import { resolveMobileViewMode, toggleViewMode, type MobileViewModeState } from "./view-mode.js";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "row",
    height: "100%",
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    "@media (max-width: 768px)": {
      flexDirection: "column",
      height: "100dvh"
    }
  },
  sidebar: {
    width: "320px",
    minWidth: "320px",
    flex: "0 0 auto",
    minHeight: 0,
    "@media (max-width: 768px)": {
      width: "100%",
      minWidth: 0,
      maxHeight: "none",
      borderBottom: "none"
    }
  },
  sidebarCollapsed: {
    width: "64px",
    minWidth: "64px",
    "@media (max-width: 768px)": {
      width: "64px",
      minWidth: "64px"
    }
  },
  main: {
    flex: "1 1 auto",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0
  },
  mainMaximized: {
    position: "fixed",
    inset: 0,
    zIndex: 10,
    backgroundColor: tokens.colorNeutralBackground1
  },
  mainHiddenMobile: {
    "@media (max-width: 768px)": {
      display: "none"
    }
  },
  hidden: {
    display: "none"
  },
  header: {
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    height: DASHBOARD_HEADER_HEIGHT,
    gap: "12px",
    padding: "12px 16px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: "13px",
    flex: "0 0 auto"
  },
  headerText: {
    flex: "1 1 auto",
    minWidth: 0,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: "13px"
  },
  headerTitleContent: {
    minWidth: 0,
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    maxWidth: "100%"
  },
  headerSessionName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  },
  headerMeta: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: "11px",
    color: tokens.colorNeutralForeground3
  },
  empty: {
    color: tokens.colorNeutralForeground3
  },
  keyBarBackdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 14,
    backgroundColor: "transparent",
    display: "none",
    "@media (max-width: 768px)": {
      display: "block"
    }
  },
  keyBarWrap: {
    position: "relative",
    zIndex: 15,
    display: "none",
    "@media (max-width: 768px)": {
      display: "flex"
    }
  },
  exitBtn: {
    position: "fixed",
    top: "8px",
    right: "8px",
    zIndex: 20
  }
});

export function scheduleTerminalRefit(
  terminal: Pick<TerminalHandle, "refit"> | null,
  requestFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame
): void {
  if (!terminal) {
    return;
  }
  requestFrame(() => {
    requestFrame(() => terminal.refit());
  });
}

export function shouldDeleteSessionWithoutDialog(session: Pick<SessionMeta, "status">): boolean {
  return session.status === "completed" || session.status === "failed" || session.status === "disconnected";
}

interface MainHeaderProps {
  activeSession: SessionMeta | null;
  hidden: boolean;
}

export function MainHeader({ activeSession, hidden }: MainHeaderProps) {
  const styles = useStyles();

  return (
    <div className={mergeClasses(styles.header, hidden && styles.hidden)}>
      <Text className={styles.headerText}>
        {activeSession ? (
          <span className={styles.headerTitleContent}>
            <span className={styles.headerSessionName}>{activeSession.name || activeSession.displayCommand}</span>
            <StatusBadge status={activeSession.status} />
          </span>
        ) : (
          <span className={styles.empty}>Select a session</span>
        )}
      </Text>
      {activeSession && (
        <span className={styles.headerMeta}>
          <span title="Session id">{activeSession.id}</span>
          {activeSession.clientVersion && <span title="Client version">v{activeSession.clientVersion}</span>}
        </span>
      )}
    </div>
  );
}

export function App() {
  const styles = useStyles();
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SessionMeta | null>(null);
  const [dialogParent, setDialogParent] = useState<
    { id: string; cwd: string; priority?: number; color?: SessionMeta["color"] } | null
  >(null);
  const [closeTarget, setCloseTarget] = useState<SessionMeta | null>(null);
  const [forceTarget, setForceTarget] = useState<SessionMeta | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarCollapsed());
  const [keyBarOpen, setKeyBarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches
  );
  const [pageVisible, setPageVisible] = useState(() =>
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [remotesEnabled, setRemotesEnabled] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [tunnelLinkOpen, setTunnelLinkOpen] = useState(false);
  const [tunnelLinkStatus, setTunnelLinkStatus] = useState<DashboardTunnelStatus | null>(null);
  const [tunnelLinkError, setTunnelLinkError] = useState("");
  const [tunnelLinkCopied, setTunnelLinkCopied] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [activeViewMode, setActiveViewMode] = useState<{ sessionId: string | null; mode: TerminalResizeMode }>({
    sessionId: null,
    mode: "clamped"
  });
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => readBrowserNotificationsEnabled());
  const [notificationMessage, setNotificationMessage] = useState<string | null>(null);
  const dismissSplash = useCallback(() => setShowSplash(false), []);
  const pendingSelectRef = useRef<string | null>(null);
  const terminalRef = useRef<TerminalHandle>(null);
  const swipeStartRef = useRef<{ x: number; y: number; fromRightEdge: boolean } | null>(null);

  useAttentionAlerts(sessions);

  // Subscribe to live session updates and load the initial list.
  useEffect(() => {
    const es = new EventSource(eventsUrl());
    es.addEventListener("sessions", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { sessions?: SessionMeta[] };
        setSessions(data.sessions ?? []);
      } catch {
        // Ignore malformed payloads; the next event will reconcile.
      }
    });
    void fetchSessions()
      .then(setSessions)
      .catch(() => {
        // SSE will deliver the list once connected.
      });
    return () => es.close();
  }, []);

  // Load the running server's version for the sidebar heading.
  useEffect(() => {
    void fetchHealth().then(({ version, remotesEnabled: enabled }) => {
      setServerVersion(version);
      setRemotesEnabled(enabled);
    });
  }, []);

  const refreshTunnelLinkStatus = useCallback(async (): Promise<void> => {
    try {
      setTunnelLinkStatus(await fetchDashboardTunnelStatus());
    } catch {
      setTunnelLinkStatus(null);
    }
  }, []);

  useEffect(() => {
    void refreshTunnelLinkStatus();
  }, [refreshTunnelLinkStatus]);

  // Reconcile the active selection whenever the list changes.
  useEffect(() => {
    const pending = pendingSelectRef.current;
    if (pending && sessions.some((s) => s.id === pending)) {
      pendingSelectRef.current = null;
      setActiveId(pending);
      return;
    }
    if (activeId && !sessions.some((s) => s.id === activeId)) {
      setActiveId(null);
      return;
    }
    if (!activeId && sessions.length > 0) {
      setActiveId(sessions[0].id);
    }
  }, [sessions, activeId]);

  // Esc exits fullscreen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && maximized) {
        setMaximized(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized]);

  // Leaving fullscreen always closes the special-key bar so re-entering
  // fullscreen starts with it hidden.
  useEffect(() => {
    if (!maximized) {
      setKeyBarOpen(false);
    }
  }, [maximized]);

  // Reveal the special-key bar with a right-to-left edge swipe while maximized.
  // Native window listeners in the capture phase are used (rather than React
  // synthetic handlers on the terminal element) so the gesture is detected
  // reliably even though xterm.js owns the touch events inside the terminal.
  // Starting near the right edge makes it a deliberate "pull-in" gesture that
  // does not clash with xterm's own touch scrolling in the body.
  useEffect(() => {
    if (!maximized) {
      return;
    }
    const onStart = (e: TouchEvent): void => {
      const t = e.touches[0];
      if (!t) {
        return;
      }
      swipeStartRef.current = {
        x: t.clientX,
        y: t.clientY,
        fromRightEdge: t.clientX >= window.innerWidth - 40
      };
    };
    const onEnd = (e: TouchEvent): void => {
      const start = swipeStartRef.current;
      swipeStartRef.current = null;
      const t = e.changedTouches[0];
      if (!start || !t || !start.fromRightEdge) {
        return;
      }
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (dx <= -50 && Math.abs(dy) <= Math.abs(dx)) {
        setKeyBarOpen(true);
      }
    };
    window.addEventListener("touchstart", onStart, { passive: true, capture: true });
    window.addEventListener("touchend", onEnd, { passive: true, capture: true });
    return () => {
      window.removeEventListener("touchstart", onStart, { capture: true });
      window.removeEventListener("touchend", onEnd, { capture: true });
    };
  }, [maximized]);

  // Track the mobile breakpoint so the terminal is only "displayed" (and thus
  // holds the PTY size) when it is actually on screen: always on desktop, but
  // only when maximized on mobile.
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 768px)");
    const onChange = (e: MediaQueryListEvent): void => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Track page visibility so the terminal is only "displayed" while the tab is
  // actually on screen. When the tab is hidden (switched away, minimized, or
  // backgrounded on mobile) the WebSocket is dropped, which the daemon observes
  // as a viewer leaving and reverts the PTY to the host terminal's size.
  useEffect(() => {
    const onVisibility = (): void => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  function removeFromList(id: string): void {
    if (activeId === id) {
      setActiveId(null);
    }
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }

  // The ✕ button signals intent to close. Finished sessions are cleaned up
  // immediately; live ones open the confirmation flow so the user can decide
  // whether to also kill the underlying process.
  function requestClose(id: string): void {
    const session = sessions.find((s) => s.id === id);
    if (!session) {
      return;
    }
    if (shouldDeleteSessionWithoutDialog(session)) {
      void deleteSession(id).then(() => removeFromList(id));
      return;
    }
    setCloseTarget(session);
  }

  async function handleCloseConfirm(kill: boolean): Promise<void> {
    const session = closeTarget;
    setCloseTarget(null);
    if (!session) {
      return;
    }
    if (!kill) {
      await deleteSession(session.id);
      removeFromList(session.id);
      return;
    }
    const { stillRunning } = await deleteSession(session.id, { kill: "graceful" });
    if (stillRunning) {
      setForceTarget(session);
    } else {
      removeFromList(session.id);
    }
  }

  async function handleForceKill(): Promise<void> {
    const session = forceTarget;
    setForceTarget(null);
    if (!session) {
      return;
    }
    await deleteSession(session.id, { kill: "force" });
    removeFromList(session.id);
  }

  function handleCreated(id: string): void {
    if (sessions.some((s) => s.id === id)) {
      setActiveId(id);
    } else {
      pendingSelectRef.current = id;
    }
  }

  // The active session's mode, tagged with the session it belongs to. It is
  // `null` right after switching sessions (before the new session's daemon
  // reports its mode) so callers never act on a stale value.
  const authoritativeViewMode = activeViewMode.sessionId === activeId ? activeViewMode.mode : null;

  const requestViewMode = useCallback(
    (mode: TerminalResizeMode): void => {
      setActiveViewMode({ sessionId: activeId, mode });
      terminalRef.current?.setViewMode(mode);
    },
    [activeId]
  );

  // On mobile the active session's shared PTY should stay clamped so a narrow
  // viewport doesn't shrink the terminal for every viewer. Remember the mode we
  // clamp away from (per session) and restore it when leaving mobile.
  const mobileViewModeRef = useRef<MobileViewModeState>({ wasMobile: isMobile, saved: null });
  useEffect(() => {
    const { requestMode, next } = resolveMobileViewMode(
      isMobile,
      activeId,
      authoritativeViewMode,
      mobileViewModeRef.current
    );
    mobileViewModeRef.current = next;
    if (requestMode) {
      requestViewMode(requestMode);
    }
  }, [isMobile, activeId, authoritativeViewMode, requestViewMode]);

  // Selecting a session on desktop moves keyboard focus into the terminal so
  // the user can start typing immediately. On mobile the terminal is offscreen
  // until maximized, so focusing it would be premature.
  const handleSelect = useCallback(
    (id: string): void => {
      const selected = sessions.find((s) => s.id === id);
      setActiveId(id);
      const attentionMatchedAt = selected?.attentionMatchedAt;
      if (selected?.status === "needs-attention" && attentionMatchedAt) {
        requestAnimationFrame(() => terminalRef.current?.acknowledgeAttention(id, attentionMatchedAt));
      }
      if (!isMobile) {
        requestAnimationFrame(() => terminalRef.current?.focus());
      }
    },
    [isMobile, sessions]
  );

  const handlePauseToggle = useCallback(async (session: SessionMeta): Promise<void> => {
    const nextStatus = session.status === "paused" ? "running" : "paused";
    const result = await updateSession(session.id, { status: nextStatus });
    if (result.ok && result.session) {
      setSessions((prev) => prev.map((current) => (current.id === result.session?.id ? result.session : current)));
    }
  }, []);

  const handleSidebarCollapsedChange = useCallback((collapsed: boolean): void => {
    setSidebarCollapsed(collapsed);
    writeSidebarCollapsed(collapsed);
    scheduleTerminalRefit(terminalRef.current);
  }, []);

  const handleToggleNotifications = useCallback((): void => {
    if (notificationsEnabled) {
      writeBrowserNotificationsEnabled(false);
      setNotificationsEnabled(false);
      return;
    }

    void requestBrowserNotificationPermission().then((permission) => {
      const enabled = notificationsEnabledFromState(permission, true);
      writeBrowserNotificationsEnabled(enabled);
      setNotificationsEnabled(enabled);
      setNotificationMessage(browserNotificationPermissionMessage(permission));
    }).catch(() => {
      writeBrowserNotificationsEnabled(false);
      setNotificationsEnabled(false);
      setNotificationMessage(browserNotificationPermissionMessage("request-failed"));
    });
  }, [notificationsEnabled]);

  const handleTunnelLink = useCallback(async (): Promise<void> => {
    setTunnelLinkOpen(true);
    setTunnelLinkError("");
    setTunnelLinkCopied(false);
    try {
      setTunnelLinkStatus(await ensureDashboardTunnel());
    } catch (e) {
      setTunnelLinkError(e instanceof Error ? e.message : "Failed to start Tunnel Link.");
      await refreshTunnelLinkStatus();
    }
  }, [refreshTunnelLinkStatus]);

  const handleCloseTunnelLink = useCallback(async (): Promise<void> => {
    setTunnelLinkError("");
    try {
      await closeDashboardTunnel();
    } catch (e) {
      setTunnelLinkError(e instanceof Error ? e.message : "Failed to close Tunnel Link.");
    } finally {
      await refreshTunnelLinkStatus();
    }
  }, [refreshTunnelLinkStatus]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  const terminalVisible = activeSession !== null && pageVisible && (!isMobile || maximized);
  const sidebarCompact = effectiveSidebarCollapsed(sidebarCollapsed, isMobile);

  return (
    <div className={styles.root}>
      {showSplash && <SplashScreen onDone={dismissSplash} />}
      <Dialog open={notificationMessage !== null} onOpenChange={(_, data) => !data.open && setNotificationMessage(null)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{browserNotificationPermissionFailureTitle}</DialogTitle>
            <DialogContent>{notificationMessage}</DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setNotificationMessage(null)}>
                OK
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <div
        className={mergeClasses(
          styles.sidebar,
          sidebarCompact && styles.sidebarCollapsed,
          maximized && styles.hidden
        )}
      >
        <Sidebar
          sessions={sessions}
          activeId={activeId}
          serverVersion={serverVersion}
          collapsed={sidebarCompact}
          collapsible={!isMobile}
          onCollapsedChange={handleSidebarCollapsedChange}
          onSelect={handleSelect}
          onClose={(id) => requestClose(id)}
          onNew={() => {
            setDialogParent(null);
            setDialogOpen(true);
          }}
          onNewFrom={(session) => {
            setDialogParent({
              id: session.id,
              cwd: session.cwd,
              priority: session.priority,
              color: session.color
            });
            setDialogOpen(true);
          }}
          onEdit={(session) => setEditTarget(session)}
          onPauseToggle={handlePauseToggle}
          onManageRemote={() => setRemoteOpen(true)}
          notificationsEnabled={notificationsEnabled}
          onToggleNotifications={handleToggleNotifications}
          tunnelLinkStatus={tunnelLinkStatus}
          onTunnelLink={() => void handleTunnelLink()}
          onCloseTunnelLink={() => void handleCloseTunnelLink()}
          showRemotesMenu={remotesEnabled}
          viewMode={isMobile ? "clamped" : authoritativeViewMode ?? "clamped"}
          viewModeLocked={isMobile}
          viewModeToggleable={authoritativeViewMode !== null}
          onViewModeToggle={() => requestViewMode(toggleViewMode(authoritativeViewMode ?? "clamped"))}
          onMaximize={(id) => {
            const selected = sessions.find((s) => s.id === id);
            setActiveId(id);
            setMaximized(true);
            const attentionMatchedAt = selected?.attentionMatchedAt;
            if (selected?.status === "needs-attention" && attentionMatchedAt) {
              requestAnimationFrame(() => terminalRef.current?.acknowledgeAttention(id, attentionMatchedAt));
            }
          }}
        />
      </div>
      <div
        className={mergeClasses(
          styles.main,
          maximized && styles.mainMaximized,
          !maximized && styles.mainHiddenMobile
        )}
      >
        <MainHeader activeSession={activeSession} hidden={maximized} />
        <TerminalView
          ref={terminalRef}
          session={activeSession}
          accentColor={activeSession?.color}
          maximized={maximized}
          visible={terminalVisible}
          viewMode={authoritativeViewMode ?? "clamped"}
          onViewModeChange={(mode) => {
            if (activeId) {
              setActiveViewMode({ sessionId: activeId, mode });
            }
          }}
        />
        {keyBarOpen && maximized && activeSession && isLiveStatus(activeSession.status) && (
          <>
            <div
              className={styles.keyBarBackdrop}
              onClick={() => setKeyBarOpen(false)}
              onTouchStart={(e) => {
                e.stopPropagation();
                setKeyBarOpen(false);
              }}
            />
            <div className={styles.keyBarWrap}>
              <KeyBar onSend={(d) => terminalRef.current?.sendInput(d)} />
            </div>
          </>
        )}
      </div>
      {maximized && (
        <Button
          className={styles.exitBtn}
          appearance="outline"
          size="small"
          icon={<Dismiss20Regular />}
          title="Exit fullscreen"
          aria-label="Exit fullscreen"
          onClick={() => setMaximized(false)}
        >
          Exit
        </Button>
      )}
      <NewSessionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        getDimensions={() => terminalRef.current?.getDimensions() ?? null}
        onCreated={handleCreated}
        parent={dialogParent}
      />
      <EditSessionDialog session={editTarget} onClose={() => setEditTarget(null)} />
      <CloseSessionDialog
        session={closeTarget}
        onCancel={() => setCloseTarget(null)}
        onConfirm={(kill) => void handleCloseConfirm(kill)}
      />
      <ForceKillDialog
        session={forceTarget}
        onNo={() => setForceTarget(null)}
        onKill={() => void handleForceKill()}
      />
      <RemoteClientDialog open={remoteOpen} onOpenChange={setRemoteOpen} />
      <TunnelLinkDialog
        open={tunnelLinkOpen}
        status={tunnelLinkStatus}
        error={tunnelLinkError}
        copied={tunnelLinkCopied}
        onCopy={setTunnelLinkCopied}
        onClose={() => setTunnelLinkOpen(false)}
      />
    </div>
  );
}
