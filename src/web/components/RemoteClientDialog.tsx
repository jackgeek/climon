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
  Textarea,
  makeStyles,
  tokens
} from "@fluentui/react-components";
import {
  addRemoteClient,
  buildSetupCommand,
  copyToClipboard,
  deleteRemoteClient,
  fetchRemoteClients,
  fetchRemoteSetup,
  type RemoteClient
} from "../api.js";

const useStyles = makeStyles({
  command: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: "12px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    backgroundColor: tokens.colorNeutralBackground3,
    padding: "8px",
    borderRadius: tokens.borderRadiusMedium
  },
  section: { marginTop: "16px" },
  clientRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    padding: "6px 0",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`
  },
  error: { color: tokens.colorPaletteRedForeground1, fontSize: "12px", minHeight: "16px" }
});

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RemoteClientDialog({ open, onOpenChange }: Props) {
  const styles = useStyles();
  const [command, setCommand] = useState("");
  const [clients, setClients] = useState<RemoteClient[]>([]);
  const [label, setLabel] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const [setup, list] = await Promise.all([fetchRemoteSetup(), fetchRemoteClients()]);
      setCommand(buildSetupCommand(setup));
      setClients(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load remote setup.");
    }
  }

  useEffect(() => {
    if (open) {
      setLabel("");
      setPublicKey("");
      setError("");
      setCopied(false);
      void refresh();
    }
  }, [open]);

  async function enroll(): Promise<void> {
    const result = await addRemoteClient(label.trim(), publicKey.trim());
    if (!result.ok) {
      setError(result.error ?? "Failed to authorize client.");
      return;
    }
    setLabel("");
    setPublicKey("");
    setError("");
    await refresh();
  }

  async function revoke(target: string): Promise<void> {
    await deleteRemoteClient(target);
    await refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Remote Clients</DialogTitle>
          <DialogContent>
            <Text>Run this on the devbox you want to connect, then paste the printed public key below:</Text>
            <div className={styles.command} style={{ marginTop: "8px" }}>{command}</div>
            <Button
              appearance="primary"
              style={{ marginTop: "8px" }}
              onClick={async () => setCopied(await copyToClipboard(command))}
            >
              {copied ? "Copied!" : "Copy command"}
            </Button>

            <div className={styles.section}>
              <Field label="Client label">
                <Input
                  value={label}
                  placeholder="e.g. devbox-1"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(_, d) => setLabel(d.value)}
                />
              </Field>
              <Field label="Client public key" style={{ marginTop: "8px" }}>
                <Textarea
                  value={publicKey}
                  placeholder="ssh-ed25519 AAAA..."
                  spellCheck={false}
                  onChange={(_, d) => setPublicKey(d.value)}
                />
              </Field>
              <Text className={styles.error} style={{ display: "block", marginTop: "8px" }}>{error}</Text>
              <Button appearance="primary" onClick={() => void enroll()} style={{ marginTop: "4px" }}>
                Authorize client
              </Button>
            </div>

            <div className={styles.section}>
              <Text weight="semibold">Authorized clients</Text>
              {clients.length === 0 ? (
                <Text style={{ display: "block", color: tokens.colorNeutralForeground3, marginTop: "4px" }}>
                  None yet.
                </Text>
              ) : (
                clients.map((c) => (
                  <div key={c.label} className={styles.clientRow}>
                    <Text style={{ fontFamily: tokens.fontFamilyMonospace, fontSize: "12px" }}>
                      {c.label} · {c.keyType} · {c.fingerprint}
                    </Text>
                    <Button appearance="subtle" size="small" onClick={() => void revoke(c.label)}>
                      Revoke
                    </Button>
                  </div>
                ))
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
