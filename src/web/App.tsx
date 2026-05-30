import { useEffect, useRef, useState } from "react";
import { Button, Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { Dismiss20Regular, Keyboard20Regular } from "@fluentui/react-icons";
import type { SessionMeta } from "../types.js";
import { eventsUrl, fetchSessions, deleteSession, fetchHealth, isLiveStatus } from "./api.js";
import { Sidebar } from "./components/Sidebar.js";
import { NewSessionDialog } from "./components/NewSessionDialog.js";
import { CloseSessionDialog, ForceKillDialog } from "./components/CloseSessionDialog.js";
import { RemoteClientDialog } from "./components/RemoteClientDialog.js";
import { TerminalView, type TerminalHandle } from "./components/TerminalView.js";
import { KeyBar } from "./components/KeyBar.js";

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
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    flex: "0 0 auto",
    minHeight: 0,
    "@media (max-width: 768px)": {
      width: "100%",
      minWidth: 0,
      maxHeight: "none",
      borderRight: "none",
      borderBottom: "none"
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
  empty: {
    color: tokens.colorNeutralForeground3
  },
  keyToggleBtn: {
    position: "fixed",
    top: "8px",
    left: "8px",
    zIndex: 20,
    display: "none",
    "@media (max-width: 768px)": {
      display: "inline-flex"
    }
  },
  keyBarWrap: {
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

export function App() {
  const styles = useStyles();
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogParent, setDialogParent] = useState<{ id: string; cwd: string } | null>(null);
  const [closeTarget, setCloseTarget] = useState<SessionMeta | null>(null);
  const [forceTarget, setForceTarget] = useState<SessionMeta | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [keyBarOpen, setKeyBarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches
  );
  const [pageVisible, setPageVisible] = useState(() =>
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const pendingSelectRef = useRef<string | null>(null);
  const terminalRef = useRef<TerminalHandle>(null);

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
    void fetchHealth().then(({ version }) => setServerVersion(version));
  }, []);

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
    if (session.status === "completed" || session.status === "failed") {
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

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  const terminalVisible = activeSession !== null && pageVisible && (!isMobile || maximized);

  return (
    <div className={styles.root}>
      <div className={mergeClasses(styles.sidebar, maximized && styles.hidden)}>
        <Sidebar
          sessions={sessions}
          activeId={activeId}
          serverVersion={serverVersion}
          onSelect={setActiveId}
          onClose={(id) => requestClose(id)}
          onNew={() => {
            setDialogParent(null);
            setDialogOpen(true);
          }}
          onNewFrom={(session) => {
            setDialogParent({ id: session.id, cwd: session.cwd });
            setDialogOpen(true);
          }}
          onManageRemote={() => setRemoteOpen(true)}
          onMaximize={(id) => {
            setActiveId(id);
            setMaximized(true);
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
        <div className={mergeClasses(styles.header, maximized && styles.hidden)}>
          <Text className={styles.headerText}>
            {activeSession ? (
              activeSession.displayCommand
            ) : (
              <span className={styles.empty}>Select a session</span>
            )}
          </Text>
        </div>
        <TerminalView ref={terminalRef} session={activeSession} maximized={maximized} visible={terminalVisible} />
        {keyBarOpen && maximized && activeSession && isLiveStatus(activeSession.status) && (
          <div className={styles.keyBarWrap}>
            <KeyBar onSend={(d) => terminalRef.current?.sendInput(d)} />
          </div>
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
      {maximized && (
        <Button
          className={styles.keyToggleBtn}
          appearance={keyBarOpen ? "primary" : "outline"}
          size="small"
          icon={<Keyboard20Regular />}
          title="Toggle special-key bar"
          aria-label="Toggle special-key bar"
          aria-pressed={keyBarOpen}
          onClick={() => setKeyBarOpen((v) => !v)}
        >
          Keys
        </Button>
      )}
      <NewSessionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        getDimensions={() => terminalRef.current?.getDimensions() ?? null}
        onCreated={handleCreated}
        parent={dialogParent}
      />
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
    </div>
  );
}
