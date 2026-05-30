import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { makeStyles } from "@fluentui/react-components";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { SessionMeta } from "../../types.js";
import { attachSocketUrl, fetchScrollback, isLiveStatus } from "../api.js";

export interface TerminalHandle {
  getDimensions: () => { cols: number; rows: number } | null;
  refit: () => void;
}

const useStyles = makeStyles({
  root: {
    flex: "1 1 auto",
    minHeight: 0,
    padding: "8px",
    backgroundColor: "#0d1117"
  }
});

interface Props {
  session: SessionMeta | null;
  maximized: boolean;
  visible: boolean;
}

export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView(
  { session, maximized, visible },
  ref
) {
  const styles = useStyles();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  function sendResize(): void {
    const term = termRef.current;
    const ws = wsRef.current;
    if (term && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  }

  function fitNow(): void {
    try {
      fitRef.current?.fit();
      sendResize();
    } catch {
      // Fit can throw while the container has zero size (e.g. mid-layout).
    }
  }

  function refit(): void {
    // Refit on the next frame so layout changes are applied before measuring.
    requestAnimationFrame(fitNow);
  }

  function closeWs(): void {
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // Ignore: socket may already be closing.
      }
      wsRef.current = null;
    }
  }

  // Create the terminal once and wire input + resize handling.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, monospace",
      fontSize: 13,
      theme: { background: "#0d1117" }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;
    fitNow();

    const onWindowResize = (): void => fitNow();
    window.addEventListener("resize", onWindowResize);

    // Register input handling once and route to the current socket. Registering
    // this per-connection would duplicate every keystroke.
    const dataDisposable = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    return () => {
      window.removeEventListener("resize", onWindowResize);
      dataDisposable.dispose();
      closeWs();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // React to the selected session: live sessions attach over WebSocket;
  // terminated ones load their captured scrollback over HTTP.
  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    closeWs();
    term.reset();

    if (!session) {
      return;
    }

    let cancelled = false;

    if (isLiveStatus(session.status)) {
      // Only hold the PTY (via the WebSocket) while the terminal is actually
      // displayed. When hidden, the daemon reverts the PTY to the host size.
      if (!visible) {
        return;
      }
      const ws = new WebSocket(attachSocketUrl(session.id));
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onopen = () => fitNow();
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data) as { type: string; exitCode?: number; cols?: number; rows?: number };
            if (msg.type === "exit") {
              term.write(`\r\n\x1b[90m[session exited with code ${msg.exitCode}]\x1b[0m\r\n`);
            } else if (msg.type === "size" && msg.cols && msg.rows) {
              // Authoritative PTY size from the daemon: match it so both the host
              // terminal and this viewer render the same grid.
              if (term.cols !== msg.cols || term.rows !== msg.rows) {
                try {
                  term.resize(msg.cols, msg.rows);
                } catch {
                  // Ignore invalid sizes.
                }
              }
            }
          } catch {
            // Ignore malformed control messages.
          }
        } else {
          term.write(new Uint8Array(ev.data as ArrayBuffer));
        }
      };
    } else {
      void fetchScrollback(session.id).then((buf) => {
        if (cancelled) {
          return;
        }
        if (buf) {
          term.write(buf);
        } else {
          term.write("\x1b[90m[no output captured]\x1b[0m\r\n");
        }
      });
    }

    return () => {
      cancelled = true;
    };
  }, [session?.id, session?.status, visible]);

  // Refit when entering/leaving fullscreen or becoming visible so xterm
  // re-measures after the container's size changes.
  useEffect(() => {
    refit();
  }, [maximized, visible]);

  useImperativeHandle(ref, () => ({
    getDimensions: () => {
      const term = termRef.current;
      return term ? { cols: term.cols, rows: term.rows } : null;
    },
    refit
  }));

  return <div ref={containerRef} className={styles.root} />;
});
