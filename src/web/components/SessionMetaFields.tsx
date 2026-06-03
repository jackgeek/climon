import {
  Field,
  Input,
  Radio,
  RadioGroup,
  makeStyles,
  tokens
} from "@fluentui/react-components";
import type { AnsiColor, SessionColorMode } from "../../types.js";
import { ANSI_COLORS } from "../../session-meta.js";
import { ANSI_CSS } from "../colors.js";

const COLOR_OPTIONS: readonly AnsiColor[] = ANSI_COLORS;

const useStyles = makeStyles({
  colors: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px"
  },
  compactColors: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "8px 12px"
  },
  swatch: {
    width: "14px",
    height: "14px",
    borderRadius: "3px",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    display: "inline-block",
    marginRight: "4px",
    verticalAlign: "middle"
  }
});

export interface MetaFieldsValue {
  name: string;
  priority: string;
  color: SessionColorMode;
}

interface Props {
  value: MetaFieldsValue;
  onChange: (value: MetaFieldsValue) => void;
  namePlaceholder: string;
  onEnter?: () => void;
  includeAuto?: boolean;
  compactColors?: boolean;
}

export function SessionMetaFields({
  value,
  onChange,
  namePlaceholder,
  onEnter,
  includeAuto = false,
  compactColors = false
}: Props) {
  const styles = useStyles();
  return (
    <>
      <Field label="Name (optional)" style={{ marginTop: "12px" }}>
        <Input
          value={value.name}
          placeholder={namePlaceholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(_, data) => onChange({ ...value, name: data.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && onEnter) {
              onEnter();
            }
          }}
        />
      </Field>
      <Field label="Priority (0–1000)" style={{ marginTop: "12px" }}>
        <Input
          type="number"
          min={0}
          max={1000}
          value={value.priority}
          onChange={(_, data) => onChange({ ...value, priority: data.value })}
        />
      </Field>
      <Field label="Color" style={{ marginTop: "12px" }}>
        <RadioGroup
          className={compactColors ? styles.compactColors : styles.colors}
          value={value.color}
          onChange={(_, data) => onChange({ ...value, color: data.value as SessionColorMode })}
        >
          {includeAuto && <Radio value="auto" label="Auto" />}
          <Radio value="none" label="None" />
          {COLOR_OPTIONS.map((color) => (
            <Radio
              key={color}
              value={color}
              label={
                <span>
                  <span className={styles.swatch} style={{ backgroundColor: ANSI_CSS[color] }} />
                  {color}
                </span>
              }
            />
          ))}
        </RadioGroup>
      </Field>
    </>
  );
}
