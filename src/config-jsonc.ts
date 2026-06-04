import { CONFIG_SETTINGS } from "./config-settings.js";

/**
 * Parses a JSONC string, stripping comments and returning the parsed object.
 * Throws an error if parsing fails, including the file path in the error message.
 */
export function parseJsoncConfig(raw: string, path: string): Record<string, unknown> {
  try {
    // Strip line comments (//...)
    // Strip block comments (/* ... */)
    // We need to be careful not to strip comment-like text inside strings
    const stripped = stripComments(raw);
    const parsed = JSON.parse(stripped);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid JSONC in ${path}: root must be an object`);
    }

    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && err.message.includes("Invalid JSONC in")) {
      throw err;
    }
    throw new Error(`Invalid JSONC in ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Strips // and /* *\/ comments from a JSON string while preserving strings.
 */
function stripComments(raw: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let stringDelimiter = "";

  while (i < raw.length) {
    const char = raw[i];
    const nextChar = i + 1 < raw.length ? raw[i + 1] : "";

    // Handle string state
    if (inString) {
      result += char;
      if (char === "\\" && nextChar) {
        // Escaped character in string
        result += nextChar;
        i += 2;
        continue;
      }
      if (char === stringDelimiter) {
        inString = false;
      }
      i++;
      continue;
    }

    // Check for string start
    if (char === '"' || char === "'") {
      inString = true;
      stringDelimiter = char;
      result += char;
      i++;
      continue;
    }

    // Check for line comment
    if (char === "/" && nextChar === "/") {
      // Skip until end of line
      i += 2;
      while (i < raw.length && raw[i] !== "\n" && raw[i] !== "\r") {
        i++;
      }
      continue;
    }

    // Check for block comment
    if (char === "/" && nextChar === "*") {
      // Skip until */
      i += 2;
      while (i < raw.length - 1) {
        if (raw[i] === "*" && raw[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Renders a config object as formatted JSONC with comments above known settings.
 * Returns a string with a trailing newline.
 */
export function renderJsoncConfig(config: Record<string, unknown>): string {
  // Build a map of setting paths to their descriptors
  const settingMap = new Map<string, typeof CONFIG_SETTINGS[0]>();
  for (const setting of CONFIG_SETTINGS) {
    settingMap.set(setting.path, setting);
  }

  const registryOrder = CONFIG_SETTINGS.map((s) => s.path);

  const rendered = renderObject(config, "", settingMap, registryOrder);
  return rendered + "\n";
}

/**
 * Recursively renders an object with proper indentation and comments.
 */
function renderObject(
  obj: Record<string, unknown>,
  prefix: string,
  settingMap: Map<string, typeof CONFIG_SETTINGS[0]>,
  registryOrder: string[],
  baseIndent: number = 0
): string {
  const indentStr = "  ".repeat(baseIndent);
  const childIndentStr = "  ".repeat(baseIndent + 1);

  const lines: string[] = [];
  lines.push("{");

  // Separate keys into known and unknown
  const allKeys = Object.keys(obj);
  const knownKeys: string[] = [];
  const unknownKeys: string[] = [];

  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const isKnown = settingMap.has(path) || hasKnownDescendant(obj[key], path, settingMap);
    if (isKnown) {
      knownKeys.push(key);
    } else {
      unknownKeys.push(key);
    }
  }

  // Sort known keys by registry order
  knownKeys.sort((a, b) => {
    const pathA = prefix ? `${prefix}.${a}` : a;
    const pathB = prefix ? `${prefix}.${b}` : b;
    
    // Find the earliest registry match for each path
    const indexA = findEarliestRegistryIndex(pathA, registryOrder);
    const indexB = findEarliestRegistryIndex(pathB, registryOrder);
    
    return indexA - indexB;
  });

  // Sort unknown keys alphabetically
  unknownKeys.sort();

  // Combine: known first, then unknown
  const sortedKeys = [...knownKeys, ...unknownKeys];

  for (let i = 0; i < sortedKeys.length; i++) {
    const key = sortedKeys[i];
    const value = obj[key];
    const path = prefix ? `${prefix}.${key}` : key;
    const isLast = i === sortedKeys.length - 1;

    // Add comment for known leaf settings
    const setting = settingMap.get(path);
    if (setting) {
      lines.push(`${childIndentStr}// ${setting.purpose}`);
    }

    // Render the value
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // Nested object
      const nestedObj = renderObject(value as Record<string, unknown>, path, settingMap, registryOrder, baseIndent + 1);
      const nestedLines = nestedObj.split("\n");
      lines.push(`${childIndentStr}"${key}": ${nestedLines[0]}`);
      for (let j = 1; j < nestedLines.length - 1; j++) {
        lines.push(nestedLines[j]);
      }
      lines.push(nestedLines[nestedLines.length - 1] + (isLast ? "" : ","));
    } else {
      // Leaf value
      const renderedValue = JSON.stringify(value);
      lines.push(`${childIndentStr}"${key}": ${renderedValue}${isLast ? "" : ","}`);
    }
  }

  lines.push(`${indentStr}}`);
  return lines.join("\n");
}

/**
 * Checks if an object or its descendants have any known settings.
 */
function hasKnownDescendant(
  value: unknown,
  prefix: string,
  settingMap: Map<string, typeof CONFIG_SETTINGS[0]>
): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  for (const key of Object.keys(value)) {
    const path = `${prefix}.${key}`;
    if (settingMap.has(path)) {
      return true;
    }
    if (hasKnownDescendant((value as Record<string, unknown>)[key], path, settingMap)) {
      return true;
    }
  }

  return false;
}

/**
 * Finds the earliest registry index for a path or its descendants.
 */
function findEarliestRegistryIndex(
  path: string,
  registryOrder: string[]
): number {
  // Check if the path itself is in the registry
  const directIndex = registryOrder.indexOf(path);
  if (directIndex !== -1) {
    return directIndex;
  }

  // Find the earliest descendant
  let earliest = Infinity;
  for (let i = 0; i < registryOrder.length; i++) {
    const regPath = registryOrder[i];
    if (regPath.startsWith(path + ".")) {
      earliest = Math.min(earliest, i);
    }
  }

  return earliest === Infinity ? registryOrder.length : earliest;
}
