import { useState } from "react";
import { Button, Input, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { encodeChar, encodeSpecial, type Mods, type SpecialKey } from "../keys.js";

interface Props {
  onSend: (data: string) => void;
}

const NO_MODS: Mods = { ctrl: false, alt: false, shift: false };

const SPECIALS: { label: string; key: SpecialKey }[] = [
  { label: "Esc", key: "Esc" },
  { label: "Tab", key: "Tab" },
  { label: "Enter", key: "Enter" },
  { label: "Del", key: "Delete" },
  { label: "Home", key: "Home" },
  { label: "End", key: "End" },
  { label: "←", key: "Left" },
  { label: "↑", key: "Up" },
  { label: "↓", key: "Down" },
  { label: "→", key: "Right" },
  { label: "PgUp", key: "PageUp" },
  { label: "PgDn", key: "PageDown" },
];

const FKEYS: { label: string; key: SpecialKey }[] = Array.from({ length: 12 }, (_, i) => ({
  label: `F${i + 1}`,
  key: `F${i + 1}` as SpecialKey
}));

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    gap: "6px",
    padding: "8px",
    width: "100%",
    boxSizing: "border-box",
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
    flex: "0 0 auto"
  },
  group: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center"

  },
  field: {
    width: "48px",
    flex: "0 0 auto"
  },
  modActive: {
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand
  },
  divider: {
    width: "1px",
    height: "24px",
    alignSelf: "center",
    backgroundColor: tokens.colorNeutralStroke2,
    flex: "0 0 auto"
  }
});

export function KeyBar({ onSend }: Props) {
  const styles = useStyles();
  const [mods, setMods] = useState<Mods>(NO_MODS);
  const [char, setChar] = useState("");

  function toggle(name: keyof Mods): void {
    setMods((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  function release(): void {
    setMods(NO_MODS);
  }

  function sendComposed(): void {
    const data = encodeChar(char, mods);
    if (data) {
      onSend(data);
    }
    release();
  }

  function sendSpecial(key: SpecialKey): void {
    const data = encodeSpecial(key, mods);
    if (data) {
      onSend(data);
    }
    release();
  }

  function modButton(label: string, name: keyof Mods) {
    return (
      <Button
        size="small"
        appearance={mods[name] ? "primary" : "outline"}
        className={mods[name] ? styles.modActive : undefined}
        aria-pressed={mods[name]}
        onClick={() => toggle(name)}
      >
        {label}
      </Button>
    );
  }

  return (
    <div className={styles.root} role="toolbar" aria-label="Special keys">
      <div className={styles.group}>
        {modButton("Ctrl", "ctrl")}
        {modButton("Alt/Opt", "alt")}
        {modButton("Shift", "shift")}
      </div>
      <div className={styles.divider} />
      <div className={styles.group}>
        <Input
          className={styles.field}
          size="small"
          value={char}
          placeholder="key"
          aria-label="Single key"
          onChange={(_e, data) => setChar(data.value.slice(-1))}
        />
        <Button size="small" appearance="outline" onClick={sendComposed}>
          Send
        </Button>
      </div>
      <div className={styles.group}>
        {SPECIALS.map((s) => (
          <Button key={s.key} size="small" appearance="subtle" onClick={() => sendSpecial(s.key)}>
            {s.label}
          </Button>
        ))}
      </div>
      <div className={styles.group}>
        {FKEYS.map((s) => (
          <Button key={s.key} size="small" appearance="subtle" onClick={() => sendSpecial(s.key)}>
            {s.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
