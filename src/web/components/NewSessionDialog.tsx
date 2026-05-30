import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Text,
  makeStyles,
  tokens
} from "@fluentui/react-components";
import { createSession } from "../api.js";

const useStyles = makeStyles({
  error: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: "12px",
    minHeight: "16px"
  }
});

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  getDimensions: () => { cols: number; rows: number } | null;
  onCreated: (id: string) => void;
}

export function NewSessionDialog({ open, onOpenChange, getDimensions, onCreated }: Props) {
  const styles = useStyles();
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setCommand("");
      setCwd("");
      setError("");
      setBusy(false);
    }
  }, [open]);

  async function submit(): Promise<void> {
    if (busy) {
      return;
    }
    const trimmed = command.trim();
    if (!trimmed) {
      setError("Command is required.");
      return;
    }
    setBusy(true);
    setError("");
    const dims = getDimensions();
    const result = await createSession({
      command: trimmed,
      cwd: cwd.trim() || undefined,
      cols: dims?.cols,
      rows: dims?.rows
    });
    if (!result.ok || !result.id) {
      setError(result.error || "Failed to create session.");
      setBusy(false);
      return;
    }
    onCreated(result.id);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New Session</DialogTitle>
          <DialogContent>
            <Field label="Command">
              <Input
                value={command}
                placeholder="e.g. npm run dev"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                onChange={(_, data) => setCommand(data.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void submit();
                  }
                }}
              />
            </Field>
            <Field label="Working directory (optional)" style={{ marginTop: "12px" }}>
              <Input
                value={cwd}
                placeholder="Leave blank for the server's working directory"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(_, data) => setCwd(data.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void submit();
                  }
                }}
              />
            </Field>
            <Text className={styles.error} style={{ display: "block", marginTop: "12px" }}>
              {error}
            </Text>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={busy} onClick={() => void submit()}>
              Create
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
