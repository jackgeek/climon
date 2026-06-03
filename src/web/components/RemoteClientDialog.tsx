import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  Option,
  Spinner,
  Text,
  makeStyles,
  tokens
} from "@fluentui/react-components";
import type { AnsiColor } from "../../types.js";
import { ANSI_CSS } from "../colors.js";
import {
  buildSetupScript,
  copyToClipboard,
  createRemoteTunnel,
  deleteRemoteTunnel,
  fetchRemoteStatus,
  recordManualTunnel,
  type RemoteStatus
} from "../api.js";
import { applyRemoteStatusToDraft, type RemoteClientDraftState } from "./remoteClientState.js";

const COLOR_OPTIONS: Array<AnsiColor | "none"> = [
  "none",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white"
];

const useStyles = makeStyles({
  script: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: "12px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    backgroundColor: tokens.colorNeutralBackground3,
    padding: "8px",
    borderRadius: tokens.borderRadiusMedium,
    marginTop: "8px"
  },
  section: { marginTop: "16px" },
  row: { display: "flex", gap: "12px", marginTop: "8px" },
  swatch: {
    width: "12px",
    height: "12px",
    borderRadius: "2px",
    display: "inline-block",
    marginRight: "6px",
    verticalAlign: "middle"
  },
  error: { color: tokens.colorPaletteRedForeground1, fontSize: "12px", minHeight: "16px", display: "block" },
  hint: { color: tokens.colorNeutralForeground3, fontSize: "12px", display: "block", marginTop: "4px" }
});

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RemoteClientDialog({ open, onOpenChange }: Props) {
  const styles = useStyles();
  const [draft, setDraft] = useState<RemoteClientDraftState>({
    status: null,
    tunnelInput: "",
    connectToken: ""
  });
  const [color, setColor] = useState<AnsiColor | "none">("none");
  const [priority, setPriority] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const { status, tunnelInput, connectToken } = draft;

  function applyStatus(s: RemoteStatus): void {
    setDraft((prev) => applyRemoteStatusToDraft(prev, s));
  }

  async function refresh(): Promise<void> {
    try {
      applyStatus(await fetchRemoteStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load remote status.");
    }
  }

  useEffect(() => {
    if (open) {
      setError("");
      setCopied(false);
      setBusy(false);
      void refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const parsedPriority = priority.trim() === "" ? undefined : Number(priority);
  const priorityValid =
    parsedPriority === undefined ||
    (Number.isInteger(parsedPriority) && parsedPriority >= 0 && parsedPriority <= 1000);

  const script = buildSetupScript({
    tunnelId: status?.tunnel?.id ?? "",
    connectToken,
    ingestPort: status?.ingestPort ?? 3132,
    color,
    priority: priorityValid ? parsedPriority : undefined
  });

  async function autoCreate(): Promise<void> {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      applyStatus(await createRemoteTunnel());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create tunnel.");
    } finally {
      setBusy(false);
    }
  }

  async function recordManual(): Promise<void> {
    if (!tunnelInput.trim()) {
      setError("Enter a dev tunnel id or URL.");
      return;
    }
    if (!connectToken.trim()) {
      setError("Enter the tunnel connect token.");
      return;
    }
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      applyStatus(await recordManualTunnel(tunnelInput.trim(), connectToken.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to record tunnel.");
    } finally {
      setBusy(false);
    }
  }

  async function teardown(): Promise<void> {
    setBusy(true);
    try {
      await deleteRemoteTunnel();
      setDraft((prev) => ({ ...prev, tunnelInput: "", connectToken: "" }));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const hasTunnel = Boolean(status?.tunnel?.id);

  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Remotes</DialogTitle>
          <DialogContent>
            <Text>
              Expose this dashboard to a devbox over a Microsoft dev tunnel. Forward
              the ingest port ({status?.ingestPort ?? 3132}) and connect your devbox
              with the generated script.
            </Text>

            {status?.devtunnelAvailable ? (
              <div className={styles.section}>
                <Button appearance="primary" disabled={busy} onClick={() => void autoCreate()}>
                  {busy ? <Spinner size="tiny" /> : hasTunnel ? "Recreate tunnel automatically" : "Create tunnel automatically"}
                </Button>
                <Text className={styles.hint}>
                  Uses the devtunnel CLI on this machine to create and host a tunnel.
                </Text>
              </div>
            ) : (
              <Text className={styles.hint}>
                The devtunnel CLI was not found on this machine. Create a tunnel
                manually and paste its id/URL and connect token below.
              </Text>
            )}

            <div className={styles.section}>
              <Field label="Dev tunnel id or URL">
                <Input
                  value={tunnelInput}
                  placeholder="abc123  or  https://abc123-3132.uks1.devtunnels.ms/"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(_, d) => setDraft((prev) => ({ ...prev, tunnelInput: d.value }))}
                />
              </Field>
              <Field label="Connect token" style={{ marginTop: "8px" }}>
                <Input
                  value={connectToken}
                  type="password"
                  placeholder="connect-scoped access token"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(_, d) => setDraft((prev) => ({ ...prev, connectToken: d.value }))}
                />
              </Field>
              <Button
                appearance="secondary"
                style={{ marginTop: "8px" }}
                disabled={busy}
                onClick={() => void recordManual()}
              >
                Use this tunnel
              </Button>
            </div>

            <div className={styles.row}>
              <Field label="Default color">
                <Dropdown
                  value={color}
                  selectedOptions={[color]}
                  onOptionSelect={(_, d) => setColor((d.optionValue as AnsiColor | "none") ?? "none")}
                >
                  {COLOR_OPTIONS.map((c) => (
                    <Option key={c} value={c} text={c}>
                      {c !== "none" && <span className={styles.swatch} style={{ backgroundColor: ANSI_CSS[c] }} />}
                      {c}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              <Field
                label="Default priority (0–1000)"
                validationState={priorityValid ? "none" : "error"}
                validationMessage={priorityValid ? undefined : "Enter an integer 0–1000."}
              >
                <Input
                  value={priority}
                  placeholder="500"
                  inputMode="numeric"
                  onChange={(_, d) => setPriority(d.value)}
                />
              </Field>
            </div>

            <Text className={styles.error}>{error}</Text>
            {status && hasTunnel && status.tunnel?.tokenExpiresAt && (
              <Text className={styles.hint}>
                Token expires {new Date(status.tunnel.tokenExpiresAt).toLocaleString()}.
                Recreate the tunnel to refresh it.
              </Text>
            )}
            {status && hasTunnel && !connectToken && (
              <Text className={styles.hint}>
                The connect token is only shown once when the tunnel is created or
                recorded. Recreate the tunnel or paste the token above to regenerate
                the script.
              </Text>
            )}

            <Text weight="semibold" style={{ display: "block", marginTop: "16px" }}>
              Run this on the devbox:
            </Text>
            <div className={styles.script}>{script}</div>
            <Button
              appearance="primary"
              style={{ marginTop: "8px" }}
              disabled={!hasTunnel || !connectToken}
              onClick={async () => setCopied(await copyToClipboard(script))}
            >
              {copied ? "Copied!" : "Copy script"}
            </Button>
          </DialogContent>
          <DialogActions>
            {hasTunnel && (
              <Button appearance="subtle" disabled={busy} onClick={() => void teardown()}>
                Remove tunnel
              </Button>
            )}
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
