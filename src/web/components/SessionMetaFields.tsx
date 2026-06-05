import {
  Dropdown,
  Field,
  Input,
  Option,
  makeStyles,
  tokens
} from "@fluentui/react-components";
import type { AnsiColor, SessionColorMode } from "../../types.js";
import { ANSI_CSS } from "../colors.js";
import { sessionColorDropdownOptions } from "../session-color-options.js";

const useStyles = makeStyles({
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
}

export function SessionMetaFields({
  value,
  onChange,
  namePlaceholder,
  onEnter,
  includeAuto = false
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
        <Dropdown
          value={value.color}
          selectedOptions={[value.color]}
          onOptionSelect={(_, data) =>
            onChange({ ...value, color: (data.optionValue as SessionColorMode | undefined) ?? "none" })
          }
        >
          {sessionColorDropdownOptions(includeAuto).map((color) => (
            <Option key={color} value={color} text={color}>
              {color !== "none" && color !== "auto" && (
                <span className={styles.swatch} style={{ backgroundColor: ANSI_CSS[color as AnsiColor] }} />
              )}
              {color === "none" ? "None" : color === "auto" ? "Auto" : color}
            </Option>
          ))}
        </Dropdown>
      </Field>
    </>
  );
}
