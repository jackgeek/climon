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
  Text,
  makeStyles,
  tokens
} from "@fluentui/react-components";
import type { SessionColorMode } from "../../types.js";
import { ANSI_CSS } from "../colors.js";
import { sessionColorDropdownOptions } from "../session-color-options.js";
import {
  buildSetupScript,
  copyToClipboard,
  fetchRemoteStatus,
  type RemoteStatus
} from "../api.js";
import { applyRemoteStatusToDraft, type RemoteClientDraftState } from "./remoteClientState.js";

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
  content: { overflowX: "visible" as const },
  row: { display: "flex", gap: "12px", marginTop: "8px", alignItems: "start" },
  field: { flex: "1 1 0", minWidth: 0 },
  control: { width: "100%", minWidth: 0 },
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

export function RemoteTunnelStatusSection({ status }: { status: RemoteStatus | null }) {
  const styles = useStyles();
  const tunnelId = status?.tunnel?.id;

  if (tunnelId) {
    return (
      <div className={styles.section}>
        <Text weight="semibold" style={{ display: "block" }}>Ingest tunnel (auto-managed)</Text>
        <Text>{tunnelId}</Text>
        <Text className={styles.hint}>
          Climon creates and reuses this labeled dev tunnel when host remotes are enabled.
        </Text>
      </div>
    );
  }

  return (
    <div className={styles.section}>
      <Text weight="semibold" style={{ display: "block" }}>Ingest tunnel (auto-managed)</Text>
      <Text className={styles.hint}>
        {status?.devtunnelAvailable
          ? "No ingest tunnel is recorded yet. Enable host remotes to let Climon create it automatically."
          : "The devtunnel CLI was not found on this machine, so Climon cannot auto-manage the ingest tunnel."}
      </Text>
    </div>
  );
}

export function RemoteClientDialog({ open, onOpenChange }: Props) {
  const styles = useStyles();
  const [draft, setDraft] = useState<RemoteClientDraftState>({
    status: null,
    tunnelInput: ""
  });
  const [color, setColor] = useState<SessionColorMode | "">("");
  const [priority, setPriority] = useState("");
  const [clientId, setClientId] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const { status } = draft;

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
      void refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const parsedPriority = priority.trim() === "" ? undefined : Number(priority);
  const priorityValid =
    parsedPriority === undefined ||
    (Number.isInteger(parsedPriority) && parsedPriority >= 0 && parsedPriority <= 1000);

  const clientIdTrimmed = clientId.trim() || undefined;
  const clientIdValid =
    clientIdTrimmed === undefined || /^[A-Za-z0-9._-]{1,64}$/.test(clientIdTrimmed);

  const script = buildSetupScript({
    tunnelId: status?.tunnel?.id ?? "",
    ingestPort: status?.ingestPort ?? 3132,
    color: color || undefined,
    priority: priorityValid ? parsedPriority : undefined,
    clientId: clientIdValid ? clientIdTrimmed : undefined,
    remoteSpawn: status?.remoteSpawn,
    spawnSecret: status?.spawnSecret
  });

  const hasTunnel = Boolean(status?.tunnel?.id);

  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Remotes</DialogTitle>
          <DialogContent className={styles.content}>
            <Text>
              Connect Climon sessions from remote machines via a Microsoft dev tunnel. 
            </Text>

            <RemoteTunnelStatusSection status={status} />

            <div className={styles.row}>
              <Field
                label="Client ID"
                className={styles.field}
                validationState={clientIdValid ? "none" : "error"}
                validationMessage={clientIdValid ? undefined : "1–64 chars: letters, digits, dots, hyphens, underscores."}
                hint="Optional. Defaults to the machine hostname. Use a value that is unique per host to avoid session ID collisions."
              >
                <Input
                  className={styles.control}
                  value={clientId}
                  placeholder="my-devbox"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(_, d) => setClientId(d.value)}
                />
              </Field>
              <Field label="Color" className={styles.field}>
                <Dropdown
                  className={styles.control}
                  value={color === "" ? "Default" : color === "none" ? "None" : color === "auto" ? "Auto" : color}
                  selectedOptions={[color]}
                  onOptionSelect={(_, d) => setColor((d.optionValue as SessionColorMode | "" | undefined) ?? "")}
                >
                  <Option value="" text="Default">Default</Option>
                  {sessionColorDropdownOptions(true).map((c) => (
                    <Option key={c} value={c} text={c}>
                      {c !== "none" && c !== "auto" && <span className={styles.swatch} style={{ backgroundColor: ANSI_CSS[c] }} />}
                      {c === "none" ? "None" : c === "auto" ? "Auto" : c}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              <Field
                label="Priority"
                className={styles.field}
                validationState={priorityValid ? "none" : "error"}
                validationMessage={priorityValid ? undefined : "0–1000"}
              >
                <Input
                  className={styles.control}
                  value={priority}
                  placeholder="500"
                  inputMode="numeric"
                  onChange={(_, d) => setPriority(d.value)}
                />
              </Field>
            </div>

            <Text className={styles.error}>{error}</Text>

            <Text weight="semibold" style={{ display: "block", marginTop: "16px" }}>
              Run this on the devbox:
            </Text>
            <div className={styles.script}>{script}</div>
            <Button
              appearance="primary"
              style={{ marginTop: "8px" }}
              disabled={!hasTunnel}
              onClick={async () => setCopied(await copyToClipboard(script))}
            >
              {copied ? "Copied!" : "Copy script"}
            </Button>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
