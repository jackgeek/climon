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
import type { DevtunnelFailure as DevtunnelFailureModel } from "../../devtunnel/types.js";
import { DevtunnelFailure } from "./DevtunnelFailure.js";

const useStyles = makeStyles({
  row: {
    display: "flex",
    gap: "8px",
    marginTop: "12px"
  },
  input: {
    flex: "1 1 auto"
  },
  hint: {
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
    display: "block",
    marginTop: "8px"
  },
  tunnelName: {
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
    display: "block",
    marginTop: "12px"
  }
});

interface Props {
  open: boolean;
  status: DashboardTunnelStatus | null;
  failure?: DevtunnelFailureModel;
  retrying: boolean;
  onRetry: () => void;
  copied: boolean;
  onCopy: (copied: boolean) => void;
  onClose: () => void;
}

type BodyProps = Omit<Props, "open" | "onClose">;

/** State-driven dialog body. Exported so it can be unit tested without the portalled Dialog surface. */
export function TunnelLinkBody({ status, failure, retrying, onRetry, copied, onCopy }: BodyProps) {
  const styles = useStyles();
  const url = status?.url ?? "";
  const tunnelId = status?.tunnelId ?? "";
  if (url) {
    return (
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
          <Button appearance="secondary" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
            Open link
          </Button>
        </div>
        <Text className={styles.hint}>
          The tunnel is not anonymous. It stays running until you choose Close
          Tunnel Link from the menu.
        </Text>
        {tunnelId && (
          <Text className={styles.tunnelName}>
            Dev tunnel: <strong>{tunnelId}</strong>
          </Text>
        )}
      </>
    );
  }
  if (failure) {
    return <DevtunnelFailure failure={failure} retry={status?.retry} onRetry={onRetry} retrying={retrying} />;
  }
  return <Text>{retrying ? "Retrying Tunnel Link…" : "Starting Tunnel Link…"}</Text>;
}

export function TunnelLinkDialog({ open, status, failure, retrying, onRetry, copied, onCopy, onClose }: Props) {
  return (
    <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Tunnel Link</DialogTitle>
          <DialogContent>
            <TunnelLinkBody
              status={status}
              failure={failure}
              retrying={retrying}
              onRetry={onRetry}
              copied={copied}
              onCopy={onCopy}
            />
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
