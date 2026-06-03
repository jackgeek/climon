import {
  Field,
  Input,
  Radio,
  RadioGroup,
  makeStyles,
  tokens
} from "@fluentui/react-components";
import type { AnsiColor } from "../../types.js";
import { ANSI_COLORS } from "../../session-meta.js";
import { ANSI_CSS } from "../colors.js";

const useStyles = makeStyles({
  colors: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px"
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
  color: AnsiColor | "none";
}

interface Props {
  value: MetaFieldsValue;
  onChange: (value: MetaFieldsValue) => void;
  namePlaceholder: string;
  onEnter?: () => void;
}

export function SessionMetaFields({ value, onChange, namePlaceholder, onEnter }: Props) {
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
          className={styles.colors}
          value={value.color}
          onChange={(_, data) => onChange({ ...value, color: data.value as AnsiColor | "none" })}
        >
          <Radio value="none" label="None" />
          {ANSI_COLORS.map((color) => (
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
