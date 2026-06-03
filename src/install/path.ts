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

export function appendPathEntryIfMissing(
  currentPath: string,
  entry: string,
  expandEnvironmentString: ExpandEnvironmentString
): string {
  if (pathContainsEntry(currentPath, entry, expandEnvironmentString)) {
    return currentPath;
  }

  const existingEntries = currentPath
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return [...existingEntries, entry].join(";");
}
