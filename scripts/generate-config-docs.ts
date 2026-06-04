import { readFileSync, writeFileSync } from "node:fs";
import { renderConfigSettingsTable } from "../src/config-settings.js";

const START = "<!-- BEGIN GENERATED CONFIG SETTINGS -->";
const END = "<!-- END GENERATED CONFIG SETTINGS -->";

export function renderConfigDocsSection(): string {
  return `### \`climon config\`

\`climon config\` works like \`git config\`. It reads project-local config first, then ancestor directories, then the global config under \`$CLIMON_HOME\`.

- \`climon config remote.tunnelId <id>\` — set a value.
- \`climon config remote.tunnelId\` — print a value (exit 1 if unset).
- \`climon config --list\` — print all set user-facing values.
- \`climon config --debug\` — print each candidate config file and the keys found in resolution order.
- \`climon config --unset remote.tunnelId\` — remove a value.
- \`climon config --help\` — print this settings reference in the terminal.
- \`--global\` writes \`$CLIMON_HOME/config.jsonc\`; \`--local\` writes \`./.climon/config.jsonc\`.

climon writes \`config.jsonc\` so generated comments can explain each setting. Legacy \`config.json\` files are read for backward compatibility and migrated to \`config.jsonc\` on first write, leaving \`config.json.bak\` as a backup.

${renderConfigSettingsTable()}
`;
}

export function replaceGeneratedConfigSection(source: string, content: string): string {
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Missing generated config markers`);
  }
  
  // Check for duplicate START markers
  const secondStart = source.indexOf(START, start + 1);
  if (secondStart !== -1) {
    throw new Error(`Duplicate START marker found at position ${secondStart}`);
  }
  
  // Check for duplicate END markers
  const secondEnd = source.indexOf(END, end + 1);
  if (secondEnd !== -1) {
    throw new Error(`Duplicate END marker found at position ${secondEnd}`);
  }
  
  return `${source.slice(0, start + START.length)}\n${content.trimEnd()}\n${source.slice(end)}`;
}

function replaceGeneratedSection(path: string, content: string): string {
  const source = readFileSync(path, "utf8");
  return replaceGeneratedConfigSection(source, content);
}

export function updateConfigDocs(): void {
  writeFileSync("docs/usage.md", replaceGeneratedSection("docs/usage.md", renderConfigDocsSection()));
}

if (import.meta.main) {
  updateConfigDocs();
}
