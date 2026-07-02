import { Button, Text, Textarea, makeStyles, tokens } from "@fluentui/react-components";
import { useEffect, useRef } from "react";
import {
  ArrowEnterLeft24Regular,
  ChevronDown24Regular,
  ChevronUp24Regular,
  Compose24Regular,
  Dismiss24Regular,
  Keyboard24Regular,
  TextFont24Regular
} from "@fluentui/react-icons";
import { KeyBar } from "./KeyBar.js";
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from "../fontSize.js";
import { encodeSpecial, type Mods } from "../keys.js";

export type TerminalPanelView = "chooser" | "keyboard" | "font" | "compose";
export type TerminalPanelArrowDirection = "up" | "down";

interface Props {
  view: TerminalPanelView;
  fontSize: number;
  composeText: string;
  showLabels: boolean;
  onSelect: (view: Exclude<TerminalPanelView, "chooser">) => void;
  onAdjustFont: (delta: number) => void;
  onComposeTextChange: (text: string) => void;
  onComposeInsert: (text: string) => void;
  onComposeCancel: () => void;
  onSend: (data: string) => void;
}

const NO_MODS: Mods = { ctrl: false, alt: false, shift: false };

export function terminalPanelArrowData(direction: TerminalPanelArrowDirection): string {
  return encodeSpecial(direction === "down" ? "PageDown" : "PageUp", NO_MODS);
}

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    gap: "12px",
    padding: "12px",
    width: "100%",
    boxSizing: "border-box",
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
    flex: "0 0 auto"
  },
  chooserLabel: {
    whiteSpace: "nowrap"
  },
  fontRow: {
    display: "flex",
    alignItems: "center",
    gap: "16px"
  },
  fontValue: {
    minWidth: "56px",
    textAlign: "center",
    fontVariantNumeric: "tabular-nums"
  },
  composeOverlay: {
    position: "fixed",
    top: "var(--climon-visual-viewport-offset-top, 0px)",
    left: "var(--climon-visual-viewport-offset-left, 0px)",
    width: "var(--climon-visual-viewport-width, 100vw)",
    height: "var(--climon-visual-viewport-height, 100dvh)",
    zIndex: 30,
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px",
    boxSizing: "border-box",
    backgroundColor: tokens.colorNeutralBackground1
  },
  composeTextarea: {
    flex: "1 1 auto",
    minHeight: 0
  },
  composeActions: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: "12px",
    flex: "0 0 auto"
  }
});

export function TerminalPanel({
  view,
  fontSize,
  composeText,
  showLabels,
  onSelect,
  onAdjustFont,
  onComposeTextChange,
  onComposeInsert,
  onComposeCancel,
  onSend
}: Props) {
  const styles = useStyles();
  const composeTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // When the composer opens with pre-existing text, select it so the user can
  // immediately replace, delete, or reuse it.
  useEffect(() => {
    if (view !== "compose") {
      return;
    }
    const el = composeTextareaRef.current;
    if (el && el.value.length > 0) {
      el.select();
    }
  }, [view]);

  if (view === "keyboard") {
    return <KeyBar onSend={onSend} />;
  }

  if (view === "compose") {
    const empty = composeText.length === 0;
    return (
      <div className={styles.composeOverlay} role="group" aria-label="Compose text">
        <Textarea
          className={styles.composeTextarea}
          value={composeText}
          placeholder="Type text to insert into the terminal…"
          aria-label="Text to insert"
          autoFocus
          resize="none"
          textarea={{ ref: composeTextareaRef, style: { height: "100%" } }}
          onChange={(_e, data) => onComposeTextChange(data.value)}
        />
        <div className={styles.composeActions}>
          <Button
            appearance="outline"
            icon={<Dismiss24Regular />}
            onClick={() => onComposeCancel()}
          >
            Cancel
          </Button>
          <Button
            appearance="primary"
            icon={<ArrowEnterLeft24Regular />}
            disabled={empty}
            onClick={() => onComposeInsert(composeText)}
          >
            Insert
          </Button>
        </div>
      </div>
    );
  }

  if (view === "font") {
    return (
      <div className={styles.root} role="group" aria-label="Font size">
        <div className={styles.fontRow}>
          <Button
            appearance="outline"
            aria-label="Decrease font size"
            disabled={fontSize <= MIN_FONT_SIZE}
            onClick={() => onAdjustFont(-1)}
          >
            A−
          </Button>
          <Text className={styles.fontValue} weight="semibold" aria-label={`Font size ${fontSize} pixels`}>
            {fontSize}px
          </Text>
          <Button
            appearance="outline"
            aria-label="Increase font size"
            disabled={fontSize >= MAX_FONT_SIZE}
            onClick={() => onAdjustFont(1)}
          >
            A+
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root} role="group" aria-label="Terminal tools">
      <Button
        appearance="outline"
        aria-label="Send PageDown"
        icon={<ChevronDown24Regular />}
        onClick={() => onSend(terminalPanelArrowData("down"))}
      />
      <Button
        appearance="outline"
        aria-label="Keyboard"
        icon={<Keyboard24Regular />}
        onClick={() => onSelect("keyboard")}
      >
        {showLabels ? <span className={styles.chooserLabel}>Keyboard</span> : undefined}
      </Button>
      <Button
        appearance="outline"
        aria-label="Font size"
        icon={<TextFont24Regular />}
        onClick={() => onSelect("font")}
      >
        {showLabels ? <span className={styles.chooserLabel}>Font size</span> : undefined}
      </Button>
      <Button
        appearance="outline"
        aria-label="Compose text"
        icon={<Compose24Regular />}
        onClick={() => onSelect("compose")}
      >
        {showLabels ? <span className={styles.chooserLabel}>Composer</span> : undefined}
      </Button>
      <Button
        appearance="outline"
        aria-label="Send PageUp"
        icon={<ChevronUp24Regular />}
        onClick={() => onSend(terminalPanelArrowData("up"))}
      />
    </div>
  );
}
