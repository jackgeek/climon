/**
 * ⚠️ LEGACY TypeScript client — frozen. Fix the Rust client instead.
 *
 * The shipping `climon` *client* is the Rust workspace under `rust/` (crates
 * `climon-cli`, `climon-session`, `climon-pty`, `climon-store`, `climon-config`,
 * `climon-remote`, `climon-install`, `climon-update`, …). This module belongs to
 * the legacy Bun/TypeScript client, kept only for local development and the Bun
 * test suite. Do NOT add features or fix client bugs here — make all client
 * changes in the Rust crates. (The Bun dashboard *server* under `src/server*`
 * and `src/web/` is NOT legacy and is still maintained.)
 */
export type ExpandEnvironmentString = (value: string) => string;

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/[\\/]+$/g, "");
}

export function normalizePathEntry(
  value: string,
  expandEnvironmentString: ExpandEnvironmentString
): string {
  return stripTrailingSlashes(stripWrappingQuotes(expandEnvironmentString(value.trim()))).toLowerCase();
}

export function pathContainsEntry(
  currentPath: string,
  entry: string,
  expandEnvironmentString: ExpandEnvironmentString
): boolean {
  const normalizedEntry = normalizePathEntry(entry, expandEnvironmentString);
  return currentPath
    .split(";")
    .filter((part) => part.trim().length > 0)
    .some((part) => normalizePathEntry(part, expandEnvironmentString) === normalizedEntry);
}

export function ensurePathEntryFirst(
  currentPath: string,
  entry: string,
  expandEnvironmentString: ExpandEnvironmentString
): string {
  const normalizedEntry = normalizePathEntry(entry, expandEnvironmentString);
  const existingEntries = currentPath
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => normalizePathEntry(part, expandEnvironmentString) !== normalizedEntry);

  return [entry, ...existingEntries].join(";");
}
