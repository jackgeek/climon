import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { makeStyles } from "@fluentui/react-components";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { SessionMeta } from "../../types.js";
import type { TerminalResizeMode } from "../../ipc/frame.js";
import { attachKey, attachSocketUrl, fetchScrollback, isLiveStatus } from "../api.js";
import { flushQueuedViewMode, sendViewModeOrQueue, type QueuedViewMode } from "../view-mode.js";
import { ANSI_HIGHLIGHT_CSS } from "../colors.js";
import { ACTIVE_SESSION_COLOR_ACCENT_WIDTH } from "../layout.js";

interface Disposable {
  dispose: () => void;
}

interface ParserTerminal {
  parser: {
    registerCsiHandler: (
      id: { prefix?: string; final: string },
      callback: (params: (number | number[])[]) => boolean
    ) => Disposable;
  };
}

const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049]);

export const terminalOptions = {
  allowProposedApi: true,
  cursorBlink: true,
  fontFamily: "ui-monospace, monospace",
  fontSize: 13,
  scrollback: 10_000,
  theme: { background: "#0d1117" }
} as const;

export function disableAlternateScreenBuffer(term: ParserTerminal): Disposable[] {
  const handleAlternateScreen = (params: (number | number[])[]): boolean =>
    params.some((param) =>
      Array.isArray(param)
        ? param.some((value) => ALTERNATE_SCREEN_MODES.has(value))
        : ALTERNATE_SCREEN_MODES.has(param)
    );

  return [
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, handleAlternateScreen),
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, handleAlternateScreen)
  ];
}

export interface TerminalHandle {
  getDimensions: () => { cols: number; rows: number } | null;
  refit: () => void;
  sendInput: (data: string) => void;
  setViewMode: (mode: TerminalResizeMode) => void;
  focus: () => void;
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
  accentColor?: SessionMeta["color"];
  maximized: boolean;
  visible: boolean;
  viewMode: TerminalResizeMode;
  onViewModeChange: (mode: TerminalResizeMode) => void;
}

export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView(
  { session, accentColor, maximized, visible, viewMode, onViewModeChange },
  ref
) {
  const styles = useStyles();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const viewModeRef = useRef<TerminalResizeMode>(viewMode);
  const onViewModeChangeRef = useRef(onViewModeChange);
  const fontSizeRef = useRef(13);
  const queuedViewModeRef = useRef<TerminalResizeMode | null>(null);

  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  useEffect(() => {
    onViewModeChangeRef.current = onViewModeChange;
  }, [onViewModeChange]);

  function sendResize(): void {
    const term = termRef.current;
    const ws = wsRef.current;
    if (term && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  }

  function sendMode(mode: TerminalResizeMode): void {
    sendViewModeOrQueue(wsRef.current, mode, queuedViewModeRef as QueuedViewMode);
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
      ...terminalOptions,
      fontSize: fontSizeRef.current
    });
    const alternateScreenDisposables = disableAlternateScreenBuffer(term);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;
    fitNow();

    const onWindowResize = (): void => fitNow();
    window.addEventListener("resize", onWindowResize);

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !event.ctrlKey) {
        return true;
      }
      const delta =
        event.key === "+" || event.key === "=" || event.code === "NumpadAdd"
          ? 1
          : event.key === "-" || event.code === "NumpadSubtract"
            ? -1
            : 0;
      if (delta === 0) {
        return true;
      }
      event.preventDefault();
      event.stopPropagation();
      const next = Math.min(32, Math.max(8, fontSizeRef.current + delta));
      if (next !== fontSizeRef.current) {
        fontSizeRef.current = next;
        term.options.fontSize = next;
        refit();
      }
      return false;
    });

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
      for (const disposable of alternateScreenDisposables) {
        disposable.dispose();
      }
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
      ws.onopen = () => {
        flushQueuedViewMode(ws, queuedViewModeRef as QueuedViewMode);
        fitNow();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data) as {
              type: string;
              exitCode?: number;
              cols?: number;
              rows?: number;
              mode?: TerminalResizeMode;
            };
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
            } else if (msg.type === "mode" && (msg.mode === "clamped" || msg.mode === "fill")) {
              onViewModeChangeRef.current(msg.mode);
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
    // Re-attach only when the session, its live/terminated state, or visibility
    // changes -- never on running <-> needs-attention idle toggles, which would
    // reset the terminal and cause a periodic resize flicker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachKey(session, visible)]);

  // Refit when layout-affecting terminal chrome changes so xterm re-measures
  // before sending geometry back to the daemon.
  useEffect(() => {
    refit();
  }, [accentColor, maximized, visible, viewMode]);

  useImperativeHandle(ref, () => ({
    getDimensions: () => {
      const term = termRef.current;
      return term ? { cols: term.cols, rows: term.rows } : null;
    },
    refit,
    sendInput: (data: string) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    },
    setViewMode: (mode: TerminalResizeMode) => {
      sendMode(mode);
      refit();
    },
    focus: () => termRef.current?.focus()
  }));

  return (
    <div
      ref={containerRef}
      className={styles.root}
      style={
        accentColor
          ? { border: `${ACTIVE_SESSION_COLOR_ACCENT_WIDTH} solid ${ANSI_HIGHLIGHT_CSS[accentColor]}` }
          : undefined
      }
    />
  );
});
