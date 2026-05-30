import { useEffect, useRef, useState } from "react";
import { Button, Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { FullScreenMaximize20Regular, Dismiss20Regular } from "@fluentui/react-icons";
import type { SessionMeta } from "../types.js";
import { eventsUrl, fetchSessions, deleteSession } from "./api.js";
import { Sidebar } from "./components/Sidebar.js";
import { NewSessionDialog } from "./components/NewSessionDialog.js";
import { TerminalView, type TerminalHandle } from "./components/TerminalView.js";

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
      maxHeight: "40vh",
      borderRight: "none",
      borderBottom: `1px solid ${tokens.colorNeutralStroke1}`
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
  maximizeBtn: {
    flex: "0 0 auto",
    display: "none",
    "@media (max-width: 768px)": {
      display: "inline-flex"
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
  const [maximized, setMaximized] = useState(false);
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

  async function handleClose(id: string): Promise<void> {
    await deleteSession(id);
    if (activeId === id) {
      setActiveId(null);
    }
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }

  function handleCreated(id: string): void {
    if (sessions.some((s) => s.id === id)) {
      setActiveId(id);
    } else {
      pendingSelectRef.current = id;
    }
  }

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  return (
    <div className={styles.root}>
      <div className={mergeClasses(styles.sidebar, maximized && styles.hidden)}>
        <Sidebar
          sessions={sessions}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={(id) => void handleClose(id)}
          onNew={() => setDialogOpen(true)}
          canCreate
        />
      </div>
      <div className={mergeClasses(styles.main, maximized && styles.mainMaximized)}>
        <div className={mergeClasses(styles.header, maximized && styles.hidden)}>
          <Text className={styles.headerText}>
            {activeSession ? (
              activeSession.displayCommand
            ) : (
              <span className={styles.empty}>Select a session</span>
            )}
          </Text>
          <Button
            className={styles.maximizeBtn}
            appearance="outline"
            size="small"
            icon={<FullScreenMaximize20Regular />}
            title="Maximize terminal"
            aria-label="Maximize terminal"
            onClick={() => setMaximized(true)}
          />
        </div>
        <TerminalView ref={terminalRef} session={activeSession} maximized={maximized} />
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
      />
    </div>
  );
}
