import { useEffect, useState } from "react";
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
  tokens
} from "@fluentui/react-components";
import type { SessionMeta } from "../../types.js";
import { updateSession } from "../api.js";
import { SessionMetaFields, type MetaFieldsValue } from "./SessionMetaFields.js";

const useStyles = makeStyles({
  error: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: "12px",
    minHeight: "16px"
  }
});

interface Props {
  session: SessionMeta | null;
  onClose: () => void;
}

export function EditSessionDialog({ session, onClose }: Props) {
  const styles = useStyles();
  const [fields, setFields] = useState<MetaFieldsValue>({ name: "", priority: "500", color: "none" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (session) {
      setFields({
        name: session.name ?? "",
        priority: String(session.priority ?? 500),
        color: session.color ?? "none"
      });
      setError("");
      setBusy(false);
    }
  }, [session]);

  async function submit(): Promise<void> {
    if (!session || busy) {
      return;
    }
    const priorityNum = Number(fields.priority);
    if (!Number.isInteger(priorityNum) || priorityNum < 0 || priorityNum > 1000) {
      setError("Priority must be an integer between 0 and 1000.");
      return;
    }
    setBusy(true);
    setError("");
    const result = await updateSession(session.id, {
      name: fields.name.trim(),
      priority: priorityNum,
      color: fields.color === "none" ? null : fields.color
    });
    if (!result.ok) {
      setError(result.error || "Failed to update session.");
      setBusy(false);
      return;
    }
    onClose();
  }

  return (
    <Dialog open={session !== null} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Edit Session</DialogTitle>
          <DialogContent>
            <SessionMetaFields
              value={fields}
              onChange={setFields}
              namePlaceholder={session?.displayCommand ?? ""}
              onEnter={() => void submit()}
            />
            <Text className={styles.error} style={{ display: "block", marginTop: "12px" }}>
              {error}
            </Text>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={busy} onClick={() => void submit()}>
              Save
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
