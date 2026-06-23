import { useEffect, useState } from "react";
import {
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Spinner
} from "@fluentui/react-components";
import { fetchFile, type FileReadResponse } from "../api.js";
import { renderFileHtml } from "../file-render.js";
import type { ParsedFileRef } from "../file-link.js";

export interface FileViewerTarget {
  sessionId: string;
  ref: ParsedFileRef;
}

interface FileViewerProps {
  target: FileViewerTarget | null;
  onClose: () => void;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
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
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<FileReadResponse | null>(null);

  useEffect(() => {
    if (!target) {
      setResp(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setResp(null);
    fetchFile(target.sessionId, target.ref.path)
      .then((r) => {
        if (!cancelled) setResp(r);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  const open = target !== null;
  const title = target ? basename(target.ref.path) : "";
  const message = resp ? statusMessage(resp) : null;
  const srcdoc =
    resp && resp.status === "ok" && target
      ? renderFileHtml({
          content: resp.content,
          filename: title,
          line: target.ref.line
        })
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) onClose();
      }}
    >
      <DialogSurface style={{ maxWidth: "min(1100px, 95vw)", width: "95vw" }}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            {loading && <Spinner label="Loading…" />}
            {!loading && message && <p>{message}</p>}
            {!loading && srcdoc && (
              <iframe
                title={title}
                sandbox=""
                srcDoc={srcdoc}
                style={{ width: "100%", height: "70vh", border: "1px solid #444", background: "#1e1e1e" }}
              />
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
