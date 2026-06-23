import { useEffect } from "react";
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import { type FileReadResponse } from "../api.js";
import { renderFileHtml } from "../file-render.js";
import type { ParsedFileRef } from "../file-link.js";

export interface FileViewerTarget {
  sessionId: string;
  cwd: string;
  ref: ParsedFileRef;
  resp: FileReadResponse;
}

interface FileViewerProps {
  target: FileViewerTarget | null;
  onClose: () => void;
}

const useStyles = makeStyles({
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 1000,
    display: "flex",
    flexDirection: "column",
    background: "#1e1e1e",
    color: "#d4d4d4"
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "8px 56px 8px 12px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    font: "12px/1.4 ui-monospace, monospace",
    whiteSpace: "nowrap",
    overflow: "hidden"
  },
  cwd: { color: "#6a737d", overflow: "hidden", textOverflow: "ellipsis", flexShrink: 1, minWidth: 0 },
  sep: { color: "#6a737d", flexShrink: 0 },
  rel: { color: "#d4d4d4", flexShrink: 0 },
  body: { flex: 1, display: "flex", minHeight: 0 },
  message: { padding: "1em 1.25em" },
  iframe: { flex: 1, width: "100%", height: "100%", border: "none", background: "#1e1e1e" },
  exitBtn: {
    position: "fixed",
    top: "calc(var(--climon-visual-viewport-offset-top, 0px) + 8px)",
    right: "8px",
    zIndex: 1001
  }
});

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function relativeToCwd(cwd: string, absPath: string): string {
  if (!cwd) return absPath;
  const base = cwd.endsWith("/") ? cwd : cwd + "/";
  return absPath.startsWith(base) ? absPath.slice(base.length) : absPath;
}

/**
 * Whether a clicked file link should open the viewer. A not-found result is a
 * silent no-op (link detection is heuristic and often points at non-files);
 * every other status represents a real file worth showing (even if only to
 * report it cannot be displayed).
 */
export function shouldOpenFileViewer(resp: FileReadResponse): boolean {
  return resp.status !== "not-found";
}

function statusMessage(resp: FileReadResponse): string | null {
  switch (resp.status) {
    case "ok":
      return null;
    case "binary":
      return "This looks like a binary file and cannot be displayed.";
    case "too-large":
      return "This file is too large to display.";
    case "refused":
      return "This file is outside the session working directory and cannot be opened.";
    case "not-found":
      return "File not found.";
    case "error":
      return resp.message;
  }
}

export function FileViewer({ target, onClose }: FileViewerProps) {
  const styles = useStyles();
  const open = target !== null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!target) return null;

  const resp = target.resp;
  const filename = basename(target.ref.path);
  const message = statusMessage(resp);
  const absPath = resp.status === "ok" ? resp.path : target.ref.path;
  const relPath = relativeToCwd(target.cwd, absPath);
  const srcdoc =
    resp.status === "ok"
      ? renderFileHtml({ content: resp.content, filename, line: target.ref.line })
      : null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`Viewing ${relPath}`}>
      <div className={styles.header}>
        <span className={styles.cwd} title={target.cwd}>
          {target.cwd}
        </span>
        <span className={styles.sep}>/</span>
        <span className={styles.rel} title={relPath}>
          {relPath}
        </span>
      </div>
      <div className={styles.body}>
        {message && <p className={styles.message}>{message}</p>}
        {srcdoc && <iframe className={styles.iframe} title={filename} sandbox="" srcDoc={srcdoc} />}
      </div>
      <Button
        className={styles.exitBtn}
        appearance="outline"
        size="small"
        icon={<Dismiss20Regular />}
        onClick={onClose}
        title="Exit file viewer"
        aria-label="Exit file viewer"
      >
        Exit
      </Button>
    </div>
  );
}
