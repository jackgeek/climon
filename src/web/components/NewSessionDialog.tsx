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
import type { CreateSessionBody } from "../api.js";
import type { AnsiColor } from "../../types.js";
import { SessionMetaFields, type MetaFieldsValue } from "./SessionMetaFields.js";

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
  /** When set, spawn a new session from this session (cwd is inherited). */
  parent?: { id: string; cwd: string; priority?: number; color?: AnsiColor | null } | null;
}

interface CreateSessionBodyInput {
  command: string;
  cwd: string;
  cols?: number;
  rows?: number;
  parentId?: string;
  name: string;
  priority: number;
  color: CreateSessionBody["color"];
}

export function buildCreateSessionBody(input: CreateSessionBodyInput): CreateSessionBody {
  return {
    command: input.command,
    cwd: input.cwd.trim() || undefined,
    cols: input.cols,
    rows: input.rows,
    parentId: input.parentId,
    name: input.name.trim() || undefined,
    priority: input.priority,
    color: input.color
  };
}

export function NewSessionDialog({ open, onOpenChange, getDimensions, onCreated, parent }: Props) {
  const styles = useStyles();
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<MetaFieldsValue>({ name: "", priority: "500", color: "auto" });

  useEffect(() => {
    if (open) {
      setCommand("");
      setCwd(parent ? parent.cwd : "");
      setFields({
        name: "",
        priority: String(parent?.priority ?? 500),
        color: parent ? parent.color ?? "none" : "auto"
      });
      setError("");
      setBusy(false);
    }
  }, [open, parent]);

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
    const priorityNum = Number(fields.priority);
    if (!Number.isInteger(priorityNum) || priorityNum < 0 || priorityNum > 1000) {
      setError("Priority must be an integer between 0 and 1000.");
      setBusy(false);
      return;
    }
    const result = await createSession(buildCreateSessionBody({
      command: trimmed,
      cwd,
      cols: dims?.cols,
      rows: dims?.rows,
      parentId: parent?.id,
      name: fields.name,
      priority: priorityNum,
      color: fields.color
    }));
    if (!result.ok) {
      setError(result.error || "Failed to create session.");
      setBusy(false);
      return;
    }
    if (result.id) {
      onCreated(result.id);
    }
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
            <Field
              label={parent ? "Working directory (defaults to selected session)" : "Working directory (optional)"}
              style={{ marginTop: "12px" }}
            >
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
            <SessionMetaFields
              value={fields}
              onChange={setFields}
              namePlaceholder="Defaults to the command"
              onEnter={() => void submit()}
              includeAuto
            />
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
