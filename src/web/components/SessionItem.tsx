import { Button, Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import {
  Dismiss16Regular,
  Add16Regular,
  FullScreenMaximize16Regular,
  Pause16Regular,
  Play16Regular,
  Settings16Regular,
  ErrorCircle16Filled,
  Warning16Filled,
  ArrowSync16Regular
} from "@fluentui/react-icons";
import { ANSI_CSS, ANSI_HIGHLIGHT_CSS } from "../colors.js";
import type { SessionMeta, TerminalProgress } from "../../types.js";
import { isLiveStatus } from "../api.js";
import { StatusBadge, STATUS_LABELS } from "./StatusBadge.js";
import { SESSION_COLOR_ACCENT_WIDTH } from "../layout.js";
import { bottomRowRightOffsets } from "./session-item-layout.js";
import { useFeature } from "../hooks/useFeature.js";
import { MOBILE_MEDIA_QUERY_RULE } from "../mobile.js";

const useStyles = makeStyles({
  root: {
    position: "relative",
    padding: "12px 16px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: "pointer",
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
    ":hover .climon-close": { display: "inline-flex" },
    ":hover .climon-new": { display: "inline-flex" },
    ":hover .climon-edit": { display: "inline-flex" },
    ":hover .climon-pause": { display: "inline-flex" }
  },
  compactRoot: {
    minHeight: "54px",
    padding: "8px 0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box"
  },
  active: {
    backgroundColor: tokens.colorNeutralBackground1Selected
  },
  activeMarker: {
    position: "absolute",
    top: "50%",
    right: 0,
    width: 0,
    height: 0,
    transform: "translateY(-50%)",
    borderTop: "12px solid transparent",
    borderBottom: "12px solid transparent",
    pointerEvents: "none"
  },
  activeMarkerLeft: {
    position: "absolute",
    top: "50%",
    left: 0,
    width: 0,
    height: 0,
    transform: "translateY(-50%)",
    borderTop: "12px solid transparent",
    borderBottom: "12px solid transparent",
    pointerEvents: "none"
  },
  cmd: {
    display: "block",
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: "13px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    paddingRight: "20px"
  },
  subtitle: {
    display: "block",
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    paddingRight: "20px",
    marginTop: "2px"
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    marginTop: "6px",
    fontSize: "11px",
    color: tokens.colorNeutralForeground3
  },
  compactMeta: {
    justifyContent: "center",
    marginTop: 0,
    gap: 0
  },
  origin: {
    fontSize: "10px",
    padding: "1px 6px",
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2
  },
  close: {
    position: "absolute",
    top: "8px",
    right: "8px",
    display: "none"
  },
  newBtn: {
    position: "absolute",
    bottom: "8px",
    display: "none"
  },
  editBtn: {
    position: "absolute",
    bottom: "8px",
    display: "none"
  },
  pauseBtn: {
    position: "absolute",
    bottom: "8px",
    display: "none"
  },
  maximize: {
    display: "none",
    marginTop: "8px",
    width: "100%",
    [MOBILE_MEDIA_QUERY_RULE]: {
      display: "inline-flex"
    }
  },
  progressTrack: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "3px",
    backgroundColor: tokens.colorNeutralBackground4,
    overflow: "hidden",
    pointerEvents: "none"
  },
  progressFill: {
    height: "100%",
    backgroundColor: tokens.colorBrandBackground,
    transition: "width 0.3s ease"
  },
  progressIcon: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0
  },
  progressError: {
    color: tokens.colorStatusDangerForeground1
  },
  progressWarning: {
    color: tokens.colorStatusWarningForeground1
  },
  spinIcon: {
    display: "inline-flex",
    color: tokens.colorBrandForeground1,
    animationName: {
      "0%": { transform: "rotate(0deg)" },
      "100%": { transform: "rotate(360deg)" }
    },
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
    "@media (prefers-reduced-motion: reduce)": {
      animationName: "none"
    }
  },
  spinIconFrozen: {
    animationName: "none"
  }
});

const PROGRESS_LABELS: Record<TerminalProgress["state"], string> = {
  normal: "In progress",
  error: "Error",
  indeterminate: "In progress",
  warning: "Warning"
};

function clampProgressValue(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

interface Props {
  session: SessionMeta;
  active: boolean;
  compact?: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: (session: SessionMeta) => void;
  onEdit: (session: SessionMeta) => void;
  onPauseToggle: (session: SessionMeta) => void;
  onMaximize: (id: string) => void;
  stateIconNoMotion?: boolean;
}

function SessionProgressIcon({
  progress,
  noMotion,
  styles
}: {
  progress: TerminalProgress;
  noMotion: boolean;
  styles: ReturnType<typeof useStyles>;
}) {
  const label = PROGRESS_LABELS[progress.state];
  switch (progress.state) {
    case "error":
      return (
        <span className={styles.progressIcon} role="img" aria-label={label} title={label}>
          <ErrorCircle16Filled className={styles.progressError} />
        </span>
      );
    case "warning":
      return (
        <span className={styles.progressIcon} role="img" aria-label={label} title={label}>
          <Warning16Filled className={styles.progressWarning} />
        </span>
      );
    case "indeterminate":
      return (
        <span
          className={mergeClasses(styles.progressIcon, styles.spinIcon, noMotion && styles.spinIconFrozen)}
          role="img"
          aria-label={label}
          title={label}
        >
          <ArrowSync16Regular />
        </span>
      );
    default:
      return null;
  }
}

function SessionProgressBar({
  progress,
  styles
}: {
  progress: TerminalProgress;
  styles: ReturnType<typeof useStyles>;
}) {
  if (progress.state !== "normal") {
    return null;
  }
  const value = clampProgressValue(progress.value);
  return (
    <div
      className={styles.progressTrack}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={PROGRESS_LABELS.normal}
    >
      <div className={styles.progressFill} style={{ width: `${value}%` }} />
    </div>
  );
}


export function sessionDisplayTitle(session: Pick<SessionMeta, "name" | "displayCommand">): string {
  return session.name || session.displayCommand;
}

export function sessionAccessibleLabel(
  session: Pick<SessionMeta, "name" | "displayCommand" | "status">,
  compact: boolean
): string | undefined {
  if (!compact) {
    return undefined;
  }
  return `${sessionDisplayTitle(session)}, ${STATUS_LABELS[session.status]}`;
}

export function SessionItem({
  session,
  active,
  compact = false,
  onSelect,
  onClose,
  onNew,
  onEdit,
  onPauseToggle,
  onMaximize,
  stateIconNoMotion = false
}: Props) {
  const styles = useStyles();
  const displayTitle = sessionDisplayTitle(session);
  const pauseTitle = session.status === "paused" ? "Resume session" : "Pause session";
  const showLiveControls = !compact && isLiveStatus(session.status);
  const sessionSpawning = useFeature("sessionSpawning").enabled;
  const rightOffsets = bottomRowRightOffsets(sessionSpawning);
  return (
    <div
      className={mergeClasses(styles.root, compact && styles.compactRoot, active && styles.active)}
      style={
        session.color
          ? active
            ? {
                border: `${SESSION_COLOR_ACCENT_WIDTH} solid ${ANSI_HIGHLIGHT_CSS[session.color]}`,
                boxSizing: "border-box"
              }
            : {
                borderRight: `${SESSION_COLOR_ACCENT_WIDTH} solid ${ANSI_CSS[session.color]}`
              }
          : undefined
      }
      title={displayTitle}
      aria-label={sessionAccessibleLabel(session, compact)}
      onClick={() => onSelect(session.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(session.id);
        }
      }}
    >
      {active && session.color && (
        <span
          className={mergeClasses("climon-active-marker", styles.activeMarker)}
          style={{ borderRight: `12px solid ${ANSI_HIGHLIGHT_CSS[session.color]}` }}
          aria-hidden="true"
        />
      )}
      {active && session.color && (
        <span
          className={mergeClasses("climon-active-marker-left", styles.activeMarkerLeft)}
          style={{ borderLeft: `12px solid ${ANSI_HIGHLIGHT_CSS[session.color]}` }}
          aria-hidden="true"
        />
      )}
      {showLiveControls && sessionSpawning && (
        <Button
          className={mergeClasses("climon-new", styles.newBtn)}
          style={{ right: `${rightOffsets.new}px` }}
          appearance="subtle"
          size="small"
          icon={<Add16Regular />}
          title="New session from here"
          aria-label="New session from here"
          onClick={(e) => {
            e.stopPropagation();
            onNew(session);
          }}
        />
      )}
      {showLiveControls && (
        <Button
          className={mergeClasses("climon-edit", styles.editBtn)}
          style={{ right: `${rightOffsets.edit}px` }}
          appearance="subtle"
          size="small"
          icon={<Settings16Regular />}
          title="Edit session"
          aria-label="Edit session"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(session);
          }}
        />
      )}
      {showLiveControls && (
        <Button
          className={mergeClasses("climon-pause", styles.pauseBtn)}
          style={{ right: `${rightOffsets.pause}px` }}
          appearance="subtle"
          size="small"
          icon={session.status === "paused" ? <Play16Regular /> : <Pause16Regular />}
          title={pauseTitle}
          aria-label={pauseTitle}
          onClick={(e) => {
            e.stopPropagation();
            onPauseToggle(session);
          }}
        />
      )}
      {!compact && (
        <Button
          className={mergeClasses("climon-close", styles.close)}
          appearance="subtle"
          size="small"
          icon={<Dismiss16Regular />}
          title="Close session"
          aria-label="Close session"
          onClick={(e) => {
            e.stopPropagation();
            onClose(session.id);
          }}
        />
      )}
      {!compact && (
        <Text
          className={styles.cmd}
          title={session.displayCommand}
        >
          {displayTitle}
        </Text>
      )}
      {!compact && session.terminalTitle && session.terminalTitle !== displayTitle && (
        <Text className={styles.subtitle} title={session.terminalTitle}>
          {session.terminalTitle}
        </Text>
      )}
      {active && !compact && (
        <Button
          className={styles.maximize}
          appearance="primary"
          size="small"
          icon={<FullScreenMaximize16Regular />}
          onClick={(e) => {
            e.stopPropagation();
            onMaximize(session.id);
          }}
        >
          Open terminal
        </Button>
      )}
      <div className={mergeClasses(styles.meta, compact && styles.compactMeta)}>
        <StatusBadge status={session.status} compact={compact} showTitle={!compact} />
        {session.progress && (
          <SessionProgressIcon progress={session.progress} noMotion={stateIconNoMotion} styles={styles} />
        )}
        {!compact && session.clientLabel && (
          <span className={styles.origin} title={session.clientLabel}>
            {session.clientLabel}
          </span>
        )}
      </div>
      {session.progress && <SessionProgressBar progress={session.progress} styles={styles} />}
    </div>
  );
}
