import {
  Button,
  Link,
  Text,
  makeStyles,
  tokens
} from "@fluentui/react-components";
import type { DevtunnelErrorCode, DevtunnelFailure as DevtunnelFailureModel, DevtunnelRetryState } from "../../devtunnel/types.js";
import { DEVTUNNEL_INSTALL_DOCS_URL } from "../devtunnel-docs.js";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    marginTop: "8px"
  },
  summary: {
    fontWeight: tokens.fontWeightSemibold
  },
  remediation: {
    color: tokens.colorNeutralForeground2,
    fontSize: "13px"
  },
  command: {
    display: "block",
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: "13px",
    backgroundColor: tokens.colorNeutralBackground3,
    padding: "6px 8px",
    borderRadius: tokens.borderRadiusMedium
  },
  timing: {
    color: tokens.colorNeutralForeground3,
    fontSize: "12px"
  },
  details: {
    marginTop: "4px",
    fontSize: "12px",
    color: tokens.colorNeutralForeground3
  },
  detailBody: {
    fontFamily: tokens.fontFamilyMonospace,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    marginTop: "6px"
  },
  actions: {
    marginTop: "4px"
  }
});

interface Props {
  failure: DevtunnelFailureModel;
  retry?: DevtunnelRetryState;
  onRetry: () => void;
  retrying: boolean;
}

/** Renders retry timing in whole seconds derived from the failure/retry hints. */
function retryTiming(failure: DevtunnelFailureModel, retry?: DevtunnelRetryState): string | null {
  let ms: number | undefined = failure.retryAfterMs;
  if (ms === undefined && retry?.nextRetryAt) {
    const delta = new Date(retry.nextRetryAt).getTime() - Date.now();
    if (Number.isFinite(delta) && delta > 0) {
      ms = delta;
    }
  }
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `Automatic retry in about ${seconds} second${seconds === 1 ? "" : "s"}.`;
}

/** Code-specific guidance blocks shown above the shared technical detail disclosure. */
function CodeGuidance({
  code,
  timing,
  styles
}: {
  code: DevtunnelErrorCode;
  timing: string | null;
  styles: ReturnType<typeof useStyles>;
}) {
  switch (code) {
    case "cli_missing":
      return (
        <>
          <Text className={styles.remediation}>
            Microsoft Dev Tunnels is not installed on the machine running the dashboard.
          </Text>
          <Link href={DEVTUNNEL_INSTALL_DOCS_URL} target="_blank" rel="noopener noreferrer">
            How to install the devtunnel CLI
          </Link>
        </>
      );
    case "not_authenticated":
      return (
        <>
          <Text className={styles.remediation}>Sign in to Microsoft Dev Tunnels, then retry:</Text>
          <code className={styles.command}>devtunnel user login</code>
        </>
      );
    case "tunnel_quota_exhausted":
      return (
        <>
          <Text className={styles.remediation}>
            Your account already has the maximum number of dev tunnels. Review your tunnels and remove one you no
            longer need, then retry:
          </Text>
          <code className={styles.command}>devtunnel list</code>
        </>
      );
    case "rate_limited":
      return timing ? <Text className={styles.timing}>{timing}</Text> : null;
    default:
      return timing ? <Text className={styles.timing}>{timing}</Text> : null;
  }
}

export function DevtunnelFailure({ failure, retry, onRetry, retrying }: Props) {
  const styles = useStyles();
  const timing = retryTiming(failure, retry);
  return (
    <div className={styles.root}>
      <Text className={styles.summary}>{failure.summary}</Text>
      {failure.remediation && failure.code !== "cli_missing" && (
        <Text className={styles.remediation}>{failure.remediation}</Text>
      )}
      <CodeGuidance code={failure.code} timing={timing} styles={styles} />
      {failure.technicalDetail && (
        <details className={styles.details}>
          <summary>Technical details</summary>
          <div className={styles.detailBody}>{failure.technicalDetail}</div>
        </details>
      )}
      <div className={styles.actions}>
        <Button appearance="primary" onClick={onRetry} disabled={retrying}>
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      </div>
    </div>
  );
}
