import { useMemo, useState } from "react";
import {
  Combobox,
  Option,
  OptionGroup,
  Field
} from "@fluentui/react-components";
import { DASHBOARD_THEMES } from "../themes.js";

const INHERIT_VALUE = "";
const INHERIT_LABEL = "Inherit default";

interface Props {
  /** Empty string = inherit the dashboard default. */
  value: string;
  onChange: (value: string) => void;
}

/**
 * Searchable, Dark/Light-grouped theme picker for the session dialogs. Selecting
 * "Inherit default" clears the per-session override (empty string). Reuses the
 * shared DASHBOARD_THEMES registry so it cannot drift from the hamburger picker.
 */
export function SessionThemePicker({ value, onChange }: Props) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? DASHBOARD_THEMES.filter((t) => t.name.toLowerCase().includes(q)) : DASHBOARD_THEMES;
  }, [query]);
  const dark = filtered.filter((t) => t.base === "dark" && t.name !== "Default");
  const light = filtered.filter((t) => t.base === "light" && t.name !== "Default");
  const hasDefault = filtered.some((t) => t.name === "Default");

  return (
    <Field label="Theme" style={{ marginTop: "12px" }}>
      <Combobox
        freeform
        placeholder="Inherit default"
        value={query === "" ? (value === INHERIT_VALUE ? INHERIT_LABEL : value) : query}
        selectedOptions={[value === INHERIT_VALUE ? INHERIT_LABEL : value]}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        onBlur={() => setQuery("")}
        onOptionSelect={(_, data) => {
          const next = data.optionValue ?? INHERIT_LABEL;
          onChange(next === INHERIT_LABEL ? INHERIT_VALUE : next);
          setQuery("");
        }}
      >
        {(hasDefault || query === "") && (
          <Option value={INHERIT_LABEL} text={INHERIT_LABEL}>
            {INHERIT_LABEL}
          </Option>
        )}
        {dark.length > 0 && (
          <OptionGroup label="Dark">
            {dark.map((t) => (
              <Option key={t.name} value={t.name} text={t.name}>
                {t.name}
              </Option>
            ))}
          </OptionGroup>
        )}
        {light.length > 0 && (
          <OptionGroup label="Light">
            {light.map((t) => (
              <Option key={t.name} value={t.name} text={t.name}>
                {t.name}
              </Option>
            ))}
          </OptionGroup>
        )}
        {dark.length === 0 && light.length === 0 && !hasDefault && (
          <Option value={INHERIT_LABEL} text="No themes found" disabled>
            No themes found
          </Option>
        )}
      </Combobox>
    </Field>
  );
}
