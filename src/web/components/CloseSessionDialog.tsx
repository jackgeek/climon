import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
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

const useStyles = makeStyles({
  hint: {
    display: "block",
    marginBottom: "12px",
    color: tokens.colorNeutralForeground3,
    fontSize: "12px"
  }
});

interface Props {
  /** The session being closed, or null when no close flow is active. */
  session: SessionMeta | null;
  onCancel: () => void;
  onConfirm: (kill: boolean) => void;
}

/**
 * First step of closing a live session: lets the user choose whether to also
 * kill the running process. Defaults the choice to the session's headless flag
 * (headless sessions have no owner watching, so default to killing).
 */
export function CloseSessionDialog({ session, onCancel, onConfirm }: Props) {
  const styles = useStyles();
  const [kill, setKill] = useState(false);

  useEffect(() => {
    if (session) {
      setKill(session.headless ?? false);
    }
  }, [session]);

  const headless = session?.headless ?? false;

  return (
    <Dialog open={session !== null} onOpenChange={(_, data) => !data.open && onCancel()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Close session</DialogTitle>
          <DialogContent>
            <Text className={styles.hint}>
              {headless
                ? "This is a headless session (no terminal is attached to it)."
                : "This is an attached session (a terminal may still be connected to it)."}
            </Text>
            <Checkbox
              checked={kill}
              label="Also kill the running process (avoids orphaned sessions)"
              onChange={(_, data) => setKill(data.checked === true)}
            />
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={() => onConfirm(kill)}>
              Close session
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

interface ForceProps {
  /** The session whose daemon ignored SIGTERM, or null when inactive. */
  session: SessionMeta | null;
  onNo: () => void;
  onKill: () => void;
}

/**
 * Second step: shown only when a graceful kill left the daemon running. Asks the
 * user to confirm a force (SIGKILL) before escalating.
 */
export function ForceKillDialog({ session, onNo, onKill }: ForceProps) {
  return (
    <Dialog open={session !== null} onOpenChange={(_, data) => !data.open && onNo()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Force kill session?</DialogTitle>
          <DialogContent>The session didn&apos;t end gracefully. Do you wish to kill it?</DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onNo}>
              No
            </Button>
            <Button appearance="primary" onClick={onKill}>
              Kill
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
