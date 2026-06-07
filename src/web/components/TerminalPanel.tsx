import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { ChevronDown24Regular, ChevronUp24Regular, Keyboard24Regular, TextFont24Regular } from "@fluentui/react-icons";
import { KeyBar } from "./KeyBar.js";
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from "../fontSize.js";
import { encodeSpecial, type Mods } from "../keys.js";

export type TerminalPanelView = "chooser" | "keyboard" | "font";
export type TerminalPanelArrowDirection = "up" | "down";

interface Props {
  view: TerminalPanelView;
  fontSize: number;
  onSelect: (view: Exclude<TerminalPanelView, "chooser">) => void;
  onAdjustFont: (delta: number) => void;
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
  chooserButton: {
    minWidth: "120px"
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
  }
});

export function TerminalPanel({ view, fontSize, onSelect, onAdjustFont, onSend }: Props) {
  const styles = useStyles();

  if (view === "keyboard") {
    return <KeyBar onSend={onSend} />;
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
        className={styles.chooserButton}
        appearance="outline"
        icon={<Keyboard24Regular />}
        onClick={() => onSelect("keyboard")}
      >
        Keyboard
      </Button>
      <Button
        className={styles.chooserButton}
        appearance="outline"
        icon={<TextFont24Regular />}
        onClick={() => onSelect("font")}
      >
        Font size
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
