import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Text,
  makeStyles,
  tokens
} from "@fluentui/react-components";
import { copyToClipboard, type DashboardTunnelStatus } from "../api.js";

const useStyles = makeStyles({
  row: {
    display: "flex",
    gap: "8px",
    marginTop: "12px"
  },
  input: {
    flex: "1 1 auto"
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: "12px",
    minHeight: "16px",
    display: "block",
    marginTop: "8px"
  },
  hint: {
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
    display: "block",
    marginTop: "8px"
  }
});

interface Props {
  open: boolean;
  status: DashboardTunnelStatus | null;
  error: string;
  copied: boolean;
  onCopy: (copied: boolean) => void;
  onClose: () => void;
}

export function TunnelLinkDialog({ open, status, error, copied, onCopy, onClose }: Props) {
  const styles = useStyles();
  const url = status?.url ?? "";
  return (
    <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Tunnel Link</DialogTitle>
          <DialogContent>
            {url ? (
              <>
                <Text>
                  Use this authenticated dev tunnel link to open the climon dashboard
                  from another device signed in with access to the tunnel.
                </Text>
                <div className={styles.row}>
                  <Input className={styles.input} value={url} readOnly />
                  <Button appearance="primary" onClick={async () => onCopy(await copyToClipboard(url))}>
                    {copied ? "Copied!" : "Copy link"}
                  </Button>
                </div>
                <Text className={styles.hint}>
                  The tunnel is not anonymous. It stays running until you choose Close
                  Tunnel Link from the menu.
                </Text>
              </>
            ) : (
              <Text>Starting Tunnel Link…</Text>
            )}
            {error && <Text className={styles.error}>{error}</Text>}
          </DialogContent>
          <DialogActions>
            {url && (
              <Button appearance="secondary" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
                Open link
              </Button>
            )}
            <Button appearance="secondary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
