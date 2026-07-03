import { useEffect, useRef, useState, useCallback } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  FluentProvider,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
  webDarkTheme,
  webLightTheme
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import type { SessionMeta } from "../types.js";
import {
  eventsUrl,
  fetchSessions,
  deleteSession,
  fetchHealth,
  probeHealthy,
  isLiveStatus,
  updateSession,
  closeDashboardTunnel,
  ensureDashboardTunnel,
  fetchDashboardTunnelStatus,
  probeTunnelAuth,
  fetchRemotes,
  type RemotesResponse,
  type DashboardTunnelStatus
} from "./api.js";
import { Sidebar } from "./components/Sidebar.js";
import { FeatureFlagsProvider, type FeatureFlagsMap } from "./hooks/useFeature.js";
import { NewSessionDialog } from "./components/NewSessionDialog.js";
import { EditSessionDialog } from "./components/EditSessionDialog.js";
import { CloseSessionDialog, ForceKillDialog } from "./components/CloseSessionDialog.js";
import { RemoteClientDialog } from "./components/RemoteClientDialog.js";
import { RemoteHostsPanel } from "./components/RemoteHostsPanel.js";
import { TunnelLinkDialog } from "./components/TunnelLinkDialog.js";
import { TerminalView, type TerminalHandle } from "./components/TerminalView.js";
import { TerminalPanel, type TerminalPanelView } from "./components/TerminalPanel.js";
import { DASHBOARD_HEADER_HEIGHT } from "./layout.js";
import { effectiveSidebarCollapsed, readSidebarCollapsed, writeSidebarCollapsed } from "./sidebarCollapse.js";
import { clampFontSize, readFontSize, writeFontSize } from "./fontSize.js";
import { getTheme } from "./themes.js";
import { DEFAULT_THEME_NAME, PREF_THEME, PREF_KEY_BAR_PINNED } from "../dashboard-preference-keys.js";
import {
  readCachedPreference,
  setDashboardPreference,
  migrateLegacyKeyBarPinned
} from "./preferences.js";
import { MOBILE_MEDIA_QUERY_RULE, TOUCH_PRIMARY_QUERY_RULE } from "./mobile.js";
import { useIsMobile } from "./hooks/useIsMobile.js";
import { useIsTouchPrimary } from "./hooks/useIsTouchPrimary.js";
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
import { toggleViewMode } from "./view-mode.js";
import { InstallPwaDialog } from "./components/InstallPwaDialog.js";
import { TunnelExpiryBanner } from "./components/TunnelExpiryBanner.js";
import { readIsStandalone, readIsTunnelOrigin, isPushSupported, canInstallPwa, reauthenticateTunnel } from "./pwa/pwaContext.js";
import {
  registerServiceWorker,
  subscribeToPush,
  unsubscribeFromPush,
  resolveNotificationMode,
  shouldShowTunnelDownBanner
} from "./pwa/push.js";
import {
  parseSessionFromSearch,
  parseOpenSessionMessage,
  isViewedSessionQuery,
  viewedSessionResponse
} from "./pwa/pushData.js";
import { computeViewedSessionId, viewedSessionAttentionAck } from "./viewedSession.js";
import { parseShortcut, matchesShortcut } from "../hotkeys.js";
import { webLog } from "./log.js";

const log = webLog("app");

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type PanelView = TerminalPanelView | "closed";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "row",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    [MOBILE_MEDIA_QUERY_RULE]: {
      flexDirection: "column",
      height: "var(--climon-visual-viewport-height, 100dvh)"
    }
  },
  sidebar: {
    width: "320px",
    minWidth: "320px",
    flex: "0 0 auto",
    minHeight: 0,
    [MOBILE_MEDIA_QUERY_RULE]: {
      width: "100%",
      minWidth: 0,
      maxHeight: "none",
      borderBottom: "none"
    }
  },
  sidebarCollapsed: {
    width: "64px",
    minWidth: "64px",
    [MOBILE_MEDIA_QUERY_RULE]: {
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
    top: "var(--climon-visual-viewport-offset-top, 0px)",
    left: "var(--climon-visual-viewport-offset-left, 0px)",
    width: "var(--climon-visual-viewport-width, 100vw)",
    height: "var(--climon-visual-viewport-height, 100dvh)",
    zIndex: 10,
    backgroundColor: tokens.colorNeutralBackground1
  },
  mainHiddenMobile: {
    [MOBILE_MEDIA_QUERY_RULE]: {
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
    [MOBILE_MEDIA_QUERY_RULE]: {
      display: "block"
    }
  },
  keyBarWrap: {
    position: "relative",
    zIndex: 15,
    display: "none",
    [MOBILE_MEDIA_QUERY_RULE]: {
      display: "flex"
    },
    [TOUCH_PRIMARY_QUERY_RULE]: {
      display: "flex"
    }
  },
  exitBtn: {
    position: "fixed",
    top: "calc(var(--climon-visual-viewport-offset-top, 0px) + 8px)",
    right: "8px",
    zIndex: 20
  },
  serverReconnectOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 2000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    padding: "24px",
    backgroundColor: "rgba(0, 0, 0, 0.62)",
    cursor: "wait"
  },
  serverReconnectCard: {
    width: "min(420px, 100%)",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "12px",
    padding: "24px",
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow64,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    textAlign: "center"
  },
  serverReconnectTitle: {
    margin: 0,
    fontSize: "20px",
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase500
  },
  serverReconnectMessage: {
    margin: 0,
    color: tokens.colorNeutralForeground2,
    lineHeight: tokens.lineHeightBase400
  },
  tunnelDownBanner: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    padding: "12px 16px",
    textAlign: "center",
    backgroundColor: tokens.colorPaletteRedBackground3,
    color: tokens.colorNeutralForegroundOnBrand
  }
});

const VISUAL_VIEWPORT_CSS_VARS = {
  height: "--climon-visual-viewport-height",
  width: "--climon-visual-viewport-width",
  offsetTop: "--climon-visual-viewport-offset-top",
  offsetLeft: "--climon-visual-viewport-offset-left"
} as const;

interface VisualViewportLayout {
  height: number;
  width: number;
  offsetTop: number;
  offsetLeft: number;
}

interface CssVariableStyle {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
}

export type ServerConnectionState = "connecting" | "connected" | "reconnecting";

function toCssPx(value: number): string {
  return `${Math.max(0, value)}px`;
}

export function applyVisualViewportLayout(
  viewport: VisualViewportLayout,
  style: CssVariableStyle = document.documentElement.style
): void {
  style.setProperty(VISUAL_VIEWPORT_CSS_VARS.height, toCssPx(viewport.height));
  style.setProperty(VISUAL_VIEWPORT_CSS_VARS.width, toCssPx(viewport.width));
  style.setProperty(VISUAL_VIEWPORT_CSS_VARS.offsetTop, toCssPx(viewport.offsetTop));
  style.setProperty(VISUAL_VIEWPORT_CSS_VARS.offsetLeft, toCssPx(viewport.offsetLeft));
}

export function clearVisualViewportLayout(style: CssVariableStyle = document.documentElement.style): void {
  style.removeProperty(VISUAL_VIEWPORT_CSS_VARS.height);
  style.removeProperty(VISUAL_VIEWPORT_CSS_VARS.width);
  style.removeProperty(VISUAL_VIEWPORT_CSS_VARS.offsetTop);
  style.removeProperty(VISUAL_VIEWPORT_CSS_VARS.offsetLeft);
}

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

export const RECONNECT_OVERLAY_DELAY_MS = 60_000;
export const RECONNECT_VISIBILITY_GRACE_MS = 5_000;

export function shouldShowServerReconnectOverlay(
  state: ServerConnectionState,
  armed: boolean
): boolean {
  return state === "reconnecting" && armed;
}

export type ConnectionOverlayKind = "auth" | "reconnect" | "none";

// The tunnel re-auth overlay takes precedence over the generic reconnect
// spinner: when the sign-in has expired, "Reconnecting…" would spin forever, so
// the actionable prompt must win.
export function activeConnectionOverlay(opts: {
  tunnelAuthRequired: boolean;
  reconnectOverlayVisible: boolean;
}): ConnectionOverlayKind {
  if (opts.tunnelAuthRequired) {
    return "auth";
  }
  if (opts.reconnectOverlayVisible) {
    return "reconnect";
  }
  return "none";
}

// "immediate" when the user just returned to the app (page became visible within
// the grace window) so a known-broken connection is surfaced right away; otherwise
// "delayed" so a drop while passively viewing waits out the 60s timer.
export function reconnectOverlayEntryMode(opts: {
  pageVisible: boolean;
  msSinceVisible: number;
}): "immediate" | "delayed" {
  return opts.pageVisible && opts.msSinceVisible <= RECONNECT_VISIBILITY_GRACE_MS
    ? "immediate"
    : "delayed";
}

export interface KeyBarSwipeStart {
  x: number;
  y: number;
  fromRightEdge: boolean;
}

// True once a right-edge touch has travelled far enough leftward (and stayed
// mostly horizontal) to count as the "pull-in" gesture that reveals the key
// bar. Evaluated continuously during touchmove so the bar opens before the
// browser can reinterpret a right-edge drag as a system navigation gesture
// (which, especially in landscape, fires touchcancel instead of touchend).
export function isKeyBarRevealSwipe(start: KeyBarSwipeStart | null, x: number, y: number): boolean {
  if (!start || !start.fromRightEdge) {
    return false;
  }
  const dx = x - start.x;
  const dy = y - start.y;
  return dx <= -50 && Math.abs(dy) <= Math.abs(dx);
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

export function ServerReconnectOverlay() {
  const styles = useStyles();
  const overlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  return (
    <div
      ref={overlayRef}
      className={styles.serverReconnectOverlay}
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      aria-labelledby="server-reconnect-title"
      aria-describedby="server-reconnect-description"
      tabIndex={-1}
      onKeyDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className={styles.serverReconnectCard}>
        <Spinner size="medium" />
        <h2 id="server-reconnect-title" className={styles.serverReconnectTitle}>
          Reconnecting
        </h2>
        <p id="server-reconnect-description" className={styles.serverReconnectMessage}>
          Re-establishing connection to the climon server...
        </p>
      </div>
    </div>
  );
}

export function TunnelReauthOverlay({ onReauth }: { onReauth: () => void }) {
  const styles = useStyles();
  const overlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  return (
    <div
      ref={overlayRef}
      className={styles.serverReconnectOverlay}
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      aria-labelledby="tunnel-reauth-title"
      aria-describedby="tunnel-reauth-description"
      tabIndex={-1}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className={styles.serverReconnectCard}>
        <h2 id="tunnel-reauth-title" className={styles.serverReconnectTitle}>
          Session expired
        </h2>
        <p id="tunnel-reauth-description" className={styles.serverReconnectMessage}>
          Your secure tunnel sign-in has expired. Sign in again to reconnect to the climon dashboard.
        </p>
        <Button appearance="primary" onClick={onReauth}>
          Sign in again
        </Button>
      </div>
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
  const [panelView, setPanelView] = useState<PanelView>("closed");
  const [composeText, setComposeText] = useState("");
  const [keyBarPinned, setKeyBarPinned] = useState<boolean>(
    () => readCachedPreference(PREF_KEY_BAR_PINNED) !== false
  );
  const [themeId, setThemeId] = useState<string>(
    () => (readCachedPreference(PREF_THEME) as string) ?? DEFAULT_THEME_NAME
  );
  const [fontSize, setFontSize] = useState(() => readFontSize());
  const isMobile = useIsMobile();
  const isTouchPrimary = useIsTouchPrimary();
  // Wide touch devices (tablets, landscape phones) show the keybar docked
  // inline beneath the already-visible side-by-side terminal. Narrow phones
  // (isMobile) keep the maximized-only fullscreen keybar flow.
  const keyBarDockedInline = isTouchPrimary && !isMobile;
  const [pageVisible, setPageVisible] = useState(() =>
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [remotesEnabled, setRemotesEnabled] = useState(false);
  const [features, setFeatures] = useState<FeatureFlagsMap>({});
  const [focusTopSessionShortcut, setFocusTopSessionShortcut] = useState<string>("Alt+J");
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteHostsOpen, setRemoteHostsOpen] = useState(false);
  const [remotes, setRemotes] = useState<RemotesResponse>({
    connections: [],
    ingestRunning: false,
    remotesActive: false
  });
  const [tunnelLinkOpen, setTunnelLinkOpen] = useState(false);
  const [tunnelLinkStatus, setTunnelLinkStatus] = useState<DashboardTunnelStatus | null>(null);
  const [tunnelLinkError, setTunnelLinkError] = useState("");
  const [tunnelLinkCopied, setTunnelLinkCopied] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [activeViewMode, setActiveViewMode] = useState<{ sessionId: string | null; mode: TerminalResizeMode }>({
    sessionId: null,
    mode: "fill"
  });
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => readBrowserNotificationsEnabled());
  const [notificationMessage, setNotificationMessage] = useState<string | null>(null);
  const [pwaInstallOpen, setPwaInstallOpen] = useState(false);
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [tunnelDownBannerVisible, setTunnelDownBannerVisible] = useState(false);
  const [pendingPopId, setPendingPopId] = useState<string | null>(null);
  const isTunnelOrigin = readIsTunnelOrigin();
  const isStandalone = readIsStandalone();
  const pushSupported = isPushSupported();
  const installAvailable = canInstallPwa({ isTunnelOrigin, isStandalone });
  const [serverConnectionState, setServerConnectionState] = useState<ServerConnectionState>("connecting");
  const [serverReconnectToken, setServerReconnectToken] = useState(0);
  const [reconnectOverlayArmed, setReconnectOverlayArmed] = useState(false);
  const reconnectOverlayArmedRef = useRef(false);
  const [tunnelAuthRequired, setTunnelAuthRequired] = useState(false);
  const tunnelAuthProbeInFlightRef = useRef(false);
  const reconnectOverlayTimerRef = useRef<number | null>(null);
  const becameVisibleAtRef = useRef<number>(Date.now());
  const pageVisibleRef = useRef(pageVisible);
  const dismissSplash = useCallback(() => setShowSplash(false), []);
  const adjustFontSize = useCallback((delta: number) => {
    setFontSize((prev) => {
      const next = clampFontSize(prev + delta);
      if (next !== prev) {
        writeFontSize(next);
      }
      return next;
    });
  }, []);
  const pendingSelectRef = useRef<string | null>(null);
  const terminalRef = useRef<TerminalHandle>(null);
  const swipeStartRef = useRef<KeyBarSwipeStart | null>(null);
  const serverConnectionStateRef = useRef<ServerConnectionState>("connecting");
  const hadServerConnectionRef = useRef(false);

  const clearReconnectOverlayTimer = useCallback((): void => {
    if (reconnectOverlayTimerRef.current !== null) {
      window.clearTimeout(reconnectOverlayTimerRef.current);
      reconnectOverlayTimerRef.current = null;
    }
  }, []);

  const armReconnectOverlay = useCallback((): void => {
    clearReconnectOverlayTimer();
    if (!reconnectOverlayArmedRef.current) {
      reconnectOverlayArmedRef.current = true;
      setReconnectOverlayArmed(true);
    }
  }, [clearReconnectOverlayTimer]);

  const disarmReconnectOverlay = useCallback((): void => {
    clearReconnectOverlayTimer();
    if (reconnectOverlayArmedRef.current) {
      reconnectOverlayArmedRef.current = false;
      setReconnectOverlayArmed(false);
    }
  }, [clearReconnectOverlayTimer]);

  const handleLiveInteraction = useCallback((): void => {
    if (serverConnectionStateRef.current === "reconnecting") {
      armReconnectOverlay();
    }
  }, [armReconnectOverlay]);

  useEffect(() => {
    if (!pushSupported || !isTunnelOrigin) {
      return;
    }
    void registerServiceWorker().catch((error) => {
      log.warn({ err: String(error) }, "Service worker registration failed");
    });
  }, [pushSupported, isTunnelOrigin]);

  useEffect(() => {
    function onBeforeInstall(event: Event): void {
      event.preventDefault();
      setDeferredInstallPrompt(event as BeforeInstallPromptEvent);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, []);

  useEffect(() => {
    if (!isStandalone) {
      return;
    }
    const FAILURE_THRESHOLD = 3;
    const POLL_INTERVAL_MS = 15000;
    let failures = 0;
    let cancelled = false;
    const timer = setInterval(() => {
      void probeHealthy().then((ok) => {
        if (cancelled) return;
        failures = ok ? 0 : failures + 1;
        setTunnelDownBannerVisible(shouldShowTunnelDownBanner(failures, FAILURE_THRESHOLD));
      });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isStandalone]);

  // Bring a session front-and-center (e.g. when a push notification is tapped).
  // Deferred via state so it also works when the session list hasn't loaded yet.
  const popSession = useCallback((id: string): void => {
    setPendingPopId(id);
  }, []);

  useEffect(() => {
    if (!pendingPopId) {
      return;
    }
    const target = sessions.find((s) => s.id === pendingPopId);
    if (!target) {
      return; // wait until the session list includes it
    }
    setPendingPopId(null);
    setActiveId(pendingPopId);
    if (isMobile) {
      setMaximized(true);
    }
    const attentionMatchedAt = target.attentionMatchedAt;
    if (target.status === "needs-attention" && attentionMatchedAt) {
      requestAnimationFrame(() => terminalRef.current?.acknowledgeAttention(pendingPopId, attentionMatchedAt));
    }
  }, [pendingPopId, sessions, isMobile]);

  // Deep link: a notification-opened window arrives at /?session=<id>.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const id = parseSessionFromSearch(window.location.search);
    if (id) {
      popSession(id);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [popSession]);

  // The session the user is actively looking at. Used to suppress its
  // needs-attention notifications and to auto-acknowledge it.
  const viewedSessionId = computeViewedSessionId({ activeId, sessions, pageVisible, isMobile, maximized });
  const viewedSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    viewedSessionIdRef.current = viewedSessionId;
  }, [viewedSessionId]);

  // Treat viewing a session as acknowledgement: when the viewed session enters
  // needs-attention, send a single ack so the daemon clears the attention state.
  const lastAutoAckKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const ack = viewedSessionAttentionAck(viewedSessionId, sessions, lastAutoAckKeyRef.current);
    if (!ack) {
      return;
    }
    lastAutoAckKeyRef.current = ack.key;
    requestAnimationFrame(() => terminalRef.current?.acknowledgeAttention(ack.sessionId, ack.attentionMatchedAt));
  }, [viewedSessionId, sessions]);

  // Notification tapped while the app was already open: the service worker
  // focuses this window and posts the session to open.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    const onMessage = (event: MessageEvent): void => {
      if (isViewedSessionQuery(event.data)) {
        event.ports[0]?.postMessage(viewedSessionResponse(viewedSessionIdRef.current));
        return;
      }
      const id = parseOpenSessionMessage(event.data);
      if (id) {
        popSession(id);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [popSession]);

  useAttentionAlerts(sessions, undefined, viewedSessionId);

  // Subscribe to live session updates and load the initial list.
  useEffect(() => {
    const es = new EventSource(eventsUrl());
    let closed = false;
    const markServerConnected = (): boolean => {
      if (closed) {
        return false;
      }
      const wasReconnecting = serverConnectionStateRef.current === "reconnecting";
      hadServerConnectionRef.current = true;
      serverConnectionStateRef.current = "connected";
      setServerConnectionState("connected");
      disarmReconnectOverlay();
      setTunnelAuthRequired(false);
      return wasReconnecting;
    };
    async function refreshSessionsAfterReconnect(): Promise<void> {
      try {
        const loadedSessions = await fetchSessions();
        if (closed) {
          return;
        }
        setSessions(loadedSessions);
        if (markServerConnected()) {
          setServerReconnectToken((token) => token + 1);
        }
      } catch {
        // Keep the blocking reconnect overlay visible until a full session list
        // refresh succeeds. EventSource will keep trying in the background.
      }
    }
    const handleServerOpen = (): void => {
      if (serverConnectionStateRef.current === "reconnecting") {
        void refreshSessionsAfterReconnect();
        return;
      }
      markServerConnected();
    };
    const applySessionsRefresh = (loadedSessions: SessionMeta[]): void => {
      if (closed) {
        return;
      }
      setSessions(loadedSessions);
      if (markServerConnected()) {
        setServerReconnectToken((token) => token + 1);
      }
    };
    const maybeProbeTunnelAuth = (): void => {
      if (!readIsTunnelOrigin() || tunnelAuthProbeInFlightRef.current) {
        return;
      }
      tunnelAuthProbeInFlightRef.current = true;
      void probeTunnelAuth()
        .then((state) => {
          if (!closed && state === "auth-required" && serverConnectionStateRef.current === "reconnecting") {
            setTunnelAuthRequired(true);
          }
        })
        .finally(() => {
          tunnelAuthProbeInFlightRef.current = false;
        });
    };
    const markServerReconnecting = (): void => {
      if (closed || !hadServerConnectionRef.current) {
        return;
      }
      // Only act on the transition into "reconnecting" so repeated EventSource
      // error events do not restart/extend the 60s timer.
      if (serverConnectionStateRef.current === "reconnecting") {
        return;
      }
      serverConnectionStateRef.current = "reconnecting";
      setServerConnectionState("reconnecting");
      maybeProbeTunnelAuth();
      const mode = reconnectOverlayEntryMode({
        pageVisible: pageVisibleRef.current,
        msSinceVisible: Date.now() - becameVisibleAtRef.current
      });
      if (mode === "immediate") {
        armReconnectOverlay();
        return;
      }
      clearReconnectOverlayTimer();
      reconnectOverlayTimerRef.current = window.setTimeout(() => {
        reconnectOverlayTimerRef.current = null;
        armReconnectOverlay();
      }, RECONNECT_OVERLAY_DELAY_MS);
    };
    es.addEventListener("open", handleServerOpen);
    es.addEventListener("error", markServerReconnecting);
    es.addEventListener("sessions", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { sessions?: SessionMeta[] };
        applySessionsRefresh(data.sessions ?? []);
      } catch {
        // Ignore malformed payloads; the next event will reconcile.
      }
    });
    es.addEventListener("remotes", (ev) => {
      try {
        setRemotes(JSON.parse((ev as MessageEvent).data) as RemotesResponse);
      } catch {
        // Ignore malformed payloads; the next event will reconcile.
      }
    });
    void fetchSessions()
      .then((loadedSessions) => {
        applySessionsRefresh(loadedSessions);
      })
      .catch(() => {
        // SSE will deliver the list once connected.
      });
    return () => {
      closed = true;
      es.close();
      clearReconnectOverlayTimer();
    };
  }, [armReconnectOverlay, disarmReconnectOverlay, clearReconnectOverlayTimer]);

  // Load the running server's version for the sidebar heading.
  useEffect(() => {
    void fetchHealth().then(
      ({ version, remotesEnabled: enabled, features: flags, focusTopSessionShortcut: shortcut, preferences }) => {
        setServerVersion(version);
        setRemotesEnabled(enabled);
        setFeatures(flags);
        setFocusTopSessionShortcut(shortcut);
        // Server config is the source of truth; reconcile cached UI prefs from it.
        const serverTheme = preferences[PREF_THEME];
        if (typeof serverTheme === "string") {
          setThemeId(serverTheme);
        }
        const serverPin = preferences[PREF_KEY_BAR_PINNED];
        if (typeof serverPin === "boolean") {
          setKeyBarPinned(serverPin);
        }
      }
    );
  }, []);

  // One-time migration of the legacy device-local key-bar pin into shared config.
  useEffect(() => {
    void migrateLegacyKeyBarPinned();
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

  // Leaving fullscreen closes the terminal panel so re-entering fullscreen
  // starts with it hidden. On a wide touch device the keybar is docked inline
  // (not tied to fullscreen), so it must survive leaving fullscreen.
  useEffect(() => {
    if (!maximized && !keyBarDockedInline) {
      setPanelView("closed");
    }
  }, [maximized, keyBarDockedInline]);

  // When the key bar is pinned, reveal the chooser bar automatically so it is
  // always available without the edge-swipe gesture: on narrow viewports when
  // entering fullscreen, and on wide touch devices where it docks inline.
  useEffect(() => {
    if (keyBarPinned && ((isMobile && maximized) || keyBarDockedInline)) {
      setPanelView((prev) => (prev === "closed" ? "chooser" : prev));
    }
  }, [isMobile, maximized, keyBarPinned, keyBarDockedInline]);

  // Reveal the special-key bar with a right-to-left edge swipe while maximized.
  // Native window listeners in the capture phase are used (rather than React
  // synthetic handlers on the terminal element) so the gesture is detected
  // reliably even though xterm.js owns the touch events inside the terminal.
  // Starting near the right edge makes it a deliberate "pull-in" gesture that
  // does not clash with xterm's own touch scrolling in the body. The gesture is
  // recognised during touchmove (not just touchend): in landscape the browser
  // frequently claims a right-edge horizontal drag as a system navigation
  // gesture and fires touchcancel instead of touchend, so waiting for touchend
  // misses it. Opening the moment the threshold is crossed wins that race.
  useEffect(() => {
    if (!maximized && !keyBarDockedInline) {
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
    const onMove = (e: TouchEvent): void => {
      const t = e.touches[0];
      if (!t) {
        return;
      }
      if (isKeyBarRevealSwipe(swipeStartRef.current, t.clientX, t.clientY)) {
        swipeStartRef.current = null;
        setPanelView("chooser");
      }
    };
    const onEnd = (e: TouchEvent): void => {
      const start = swipeStartRef.current;
      swipeStartRef.current = null;
      const t = e.changedTouches[0];
      if (t && isKeyBarRevealSwipe(start, t.clientX, t.clientY)) {
        setPanelView("chooser");
      }
    };
    const onCancel = (): void => {
      swipeStartRef.current = null;
    };
    window.addEventListener("touchstart", onStart, { passive: true, capture: true });
    window.addEventListener("touchmove", onMove, { passive: true, capture: true });
    window.addEventListener("touchend", onEnd, { passive: true, capture: true });
    window.addEventListener("touchcancel", onCancel, { passive: true, capture: true });
    return () => {
      window.removeEventListener("touchstart", onStart, { capture: true });
      window.removeEventListener("touchmove", onMove, { capture: true });
      window.removeEventListener("touchend", onEnd, { capture: true });
      window.removeEventListener("touchcancel", onCancel, { capture: true });
    };
  }, [maximized, keyBarDockedInline]);

  // Track page visibility so the terminal is only "displayed" while the tab is
  // actually on screen. When the tab is hidden (switched away, minimized, or
  // backgrounded on mobile) the WebSocket is dropped, which the daemon observes
  // as a viewer leaving and reverts the PTY to the host terminal's size.
  useEffect(() => {
    const onVisibility = (): void => {
      const visible = document.visibilityState !== "hidden";
      setPageVisible(visible);
      pageVisibleRef.current = visible;
      if (visible) {
        becameVisibleAtRef.current = Date.now();
        // Returning to the app with a known-broken connection should surface the
        // overlay right away rather than waiting out the 60s timer.
        if (serverConnectionStateRef.current === "reconnecting") {
          armReconnectOverlay();
        }
        // A backgrounded tab can leave the xterm renderer with a stale GPU/canvas
        // frame, so the terminal looks corrupted until something forces a repaint
        // (scrolling or clicking already fixes it). Always repaint on return.
        // On desktop also focus the terminal so the user can type immediately;
        // skip focusing on mobile so we don't summon the soft keyboard on a mere
        // tab-switch. Deferred a frame so the browser can restore the rendering
        // context first, matching the focus pattern used elsewhere in this component.
        requestAnimationFrame(() => {
          const term = terminalRef.current;
          if (!term) {
            return;
          }
          if (isMobile) {
            term.refresh();
          } else {
            term.focus();
          }
        });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [armReconnectOverlay, isMobile]);

  // The terminal panel is a flex child that shrinks the terminal pane when
  // shown. xterm does not reflow to the smaller pane on its own, so refit it
  // whenever the panel opens or closes to keep its bottom rows above the panel.
  useEffect(() => {
    scheduleTerminalRefit(terminalRef.current);
  }, [panelView]);

  // Mobile soft keyboards shrink the visual viewport without reliably changing
  // CSS vh/dvh units on every browser. Mirror the visual viewport into CSS so
  // fixed/full-height UI and xterm fit inside the visible area while typing.
  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      return;
    }
    const onVisualViewportChange = (): void => {
      applyVisualViewportLayout(visualViewport);
      scheduleTerminalRefit(terminalRef.current);
    };
    onVisualViewportChange();
    visualViewport.addEventListener("resize", onVisualViewportChange);
    visualViewport.addEventListener("scroll", onVisualViewportChange);
    return () => {
      visualViewport.removeEventListener("resize", onVisualViewportChange);
      visualViewport.removeEventListener("scroll", onVisualViewportChange);
      clearVisualViewportLayout();
    };
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

  function handleRemoveDisconnected(): void {
    const targets = sessions.filter(
      (s) => s.status === "completed" || s.status === "failed" || s.status === "disconnected"
    );
    for (const s of targets) {
      void deleteSession(s.id).then(() => removeFromList(s.id));
    }
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

  const sessionsRef = useRef<SessionMeta[]>(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const handleSelectRef = useRef(handleSelect);
  useEffect(() => {
    handleSelectRef.current = handleSelect;
  }, [handleSelect]);

  useEffect(() => {
    const parsed = parseShortcut(focusTopSessionShortcut);
    if (!parsed) {
      return; // empty or invalid shortcut disables the feature
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!matchesShortcut(event, parsed)) {
        return;
      }
      const current = sessionsRef.current;
      if (current.length === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      handleSelectRef.current(current[0].id);
    };
    // Capture phase so the shortcut wins even while the xterm has focus.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [focusTopSessionShortcut]);

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

  const handleToggleKeyBarPinned = useCallback((): void => {
    setKeyBarPinned((prev) => {
      const next = !prev;
      void setDashboardPreference(PREF_KEY_BAR_PINNED, next);
      return next;
    });
  }, []);

  const handleSelectTheme = useCallback((id: string): void => {
    setThemeId(id);
    void setDashboardPreference(PREF_THEME, id);
  }, []);

  const handleToggleNotifications = useCallback((): void => {
    const mode = resolveNotificationMode({ pushSupported, isTunnelOrigin });

    if (mode === "push") {
      if (notificationsEnabled) {
        writeBrowserNotificationsEnabled(false);
        setNotificationsEnabled(false);
        void unsubscribeFromPush().catch((error) => log.warn({ err: String(error) }, "Push unsubscribe failed"));
        return;
      }
      void requestBrowserNotificationPermission().then(async (permission) => {
        const granted = notificationsEnabledFromState(permission, true);
        if (!granted) {
          writeBrowserNotificationsEnabled(false);
          setNotificationsEnabled(false);
          setNotificationMessage(browserNotificationPermissionMessage(permission));
          return;
        }
        try {
          await subscribeToPush();
          writeBrowserNotificationsEnabled(true);
          setNotificationsEnabled(true);
          setNotificationMessage(null);
        } catch (error) {
          log.warn({ err: String(error) }, "Push subscribe failed");
          writeBrowserNotificationsEnabled(false);
          setNotificationsEnabled(false);
          setNotificationMessage("Failed to enable push notifications. Make sure climon is installed to your home screen and try again.");
        }
      }).catch(() => {
        writeBrowserNotificationsEnabled(false);
        setNotificationsEnabled(false);
        setNotificationMessage(browserNotificationPermissionMessage("request-failed"));
      });
      return;
    }

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
  }, [notificationsEnabled, pushSupported, isTunnelOrigin]);

  const handleInstallPwa = useCallback((): void => {
    const prompt = deferredInstallPrompt;
    if (prompt) {
      void prompt.prompt().finally(() => {
        setDeferredInstallPrompt(null);
        setPwaInstallOpen(false);
      });
      return;
    }
    // iOS / no programmatic prompt: dialog already shows manual instructions.
  }, [deferredInstallPrompt]);

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
  // The keybar and its compose overlay only render for a live session that is
  // either maximized (narrow flow) or docked inline (wide touch).
  const keyBarAvailable =
    (maximized || keyBarDockedInline) && activeSession !== null && isLiveStatus(activeSession.status);
  // The compose overlay covers the whole viewport (including the fixed exit
  // button), so the exit button is hidden only while the overlay is actually
  // showing. Tying it to the overlay's own render condition avoids trapping the
  // user in fullscreen if the session stops being live mid-compose.
  const composeOverlayVisible = keyBarAvailable && panelView === "compose";
  const serverConnected = serverConnectionState === "connected";
  const serverReconnectOverlayVisible = shouldShowServerReconnectOverlay(
    serverConnectionState,
    reconnectOverlayArmed
  );
  const connectionOverlay = activeConnectionOverlay({
    tunnelAuthRequired,
    reconnectOverlayVisible: serverReconnectOverlayVisible
  });

  const activeTheme = getTheme(activeSession?.theme ?? themeId);
  const fluentTheme = activeTheme.base === "light" ? webLightTheme : webDarkTheme;

  return (
    <FluentProvider theme={fluentTheme} style={{ height: "100%" }}>
    <FeatureFlagsProvider value={features}>
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
      <InstallPwaDialog
        open={pwaInstallOpen}
        canPrompt={deferredInstallPrompt !== null}
        onOpenChange={setPwaInstallOpen}
        onInstall={handleInstallPwa}
      />
      {!isMobile && <TunnelExpiryBanner />}
      {tunnelDownBannerVisible && (
        <div role="alert" className={styles.tunnelDownBanner}>
          This climon Tunnel Link is no longer available. Long-press the climon icon and choose Uninstall.
        </div>
      )}
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
          onShowRemoteHosts={() => {
            setRemoteHostsOpen(true);
            void fetchRemotes().then(setRemotes);
          }}
          notificationsEnabled={notificationsEnabled}
          onToggleNotifications={handleToggleNotifications}
          canInstallPwa={installAvailable}
          onInstallPwa={() => setPwaInstallOpen(true)}
          tunnelLinkStatus={tunnelLinkStatus}
          onTunnelLink={() => void handleTunnelLink()}
          onCloseTunnelLink={() => void handleCloseTunnelLink()}
          showRemotesMenu={remotesEnabled}
          onRemoveDisconnected={handleRemoveDisconnected}
          isMobile={isMobile}
          keyBarPinned={keyBarPinned}
          onToggleKeyBarPinned={handleToggleKeyBarPinned}
          currentTheme={themeId}
          onSelectTheme={handleSelectTheme}
          viewMode={authoritativeViewMode ?? "fill"}
          viewModeLocked={false}
          onViewModeToggle={() => requestViewMode(toggleViewMode(authoritativeViewMode ?? "fill"))}
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
          viewMode={authoritativeViewMode ?? "fill"}
          onViewModeChange={(mode) => {
            if (activeId) {
              setActiveViewMode({ sessionId: activeId, mode });
            }
          }}
          fontSize={fontSize}
          xtermTheme={activeTheme.xterm}
          onFontSizeChange={adjustFontSize}
          serverConnected={serverConnected}
          serverReconnectToken={serverReconnectToken}
          onLiveInteraction={handleLiveInteraction}
        />
        {panelView !== "closed" && keyBarAvailable && (
          <>
            {maximized && !(keyBarPinned && panelView === "chooser") && (
              <div
                className={styles.keyBarBackdrop}
                onClick={() => setPanelView(keyBarPinned ? "chooser" : "closed")}
                onTouchStart={(e) => {
                  e.stopPropagation();
                  setPanelView(keyBarPinned ? "chooser" : "closed");
                }}
              />
            )}
            <div className={styles.keyBarWrap}>
              <TerminalPanel
                view={panelView}
                fontSize={fontSize}
                composeText={composeText}
                showLabels={!isMobile}
                onSelect={setPanelView}
                onAdjustFont={adjustFontSize}
                onComposeTextChange={setComposeText}
                onComposeInsert={(text) => {
                  terminalRef.current?.sendInput(text);
                  setComposeText("");
                  setPanelView(keyBarPinned ? "chooser" : "closed");
                }}
                onComposeCancel={() => {
                  setPanelView(keyBarPinned ? "chooser" : "closed");
                }}
                onSend={(d) => terminalRef.current?.sendInput(d)}
              />
            </div>
          </>
        )}
      </div>
      {maximized && !composeOverlayVisible && (
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
      <RemoteHostsPanel
        open={remoteHostsOpen}
        onClose={() => setRemoteHostsOpen(false)}
        connections={remotes.connections}
        remotesActive={remotes.remotesActive}
      />
      <TunnelLinkDialog
        open={tunnelLinkOpen}
        status={tunnelLinkStatus}
        error={tunnelLinkError}
        copied={tunnelLinkCopied}
        onCopy={setTunnelLinkCopied}
        onClose={() => setTunnelLinkOpen(false)}
      />
      {connectionOverlay === "auth" && (
        <TunnelReauthOverlay
          onReauth={() =>
            reauthenticateTunnel({
              isStandalone,
              href: window.location.href,
              openBrowser: (url) => window.open(url, "_blank", "noopener"),
              navigate: (url) => window.location.assign(url),
            })
          }
        />
      )}
      {connectionOverlay === "reconnect" && <ServerReconnectOverlay />}
    </div>
    </FeatureFlagsProvider>
    </FluentProvider>
  );
}
