import { isDeepStrictEqual } from "node:util";

export type ConfigDelta =
  | { kind: "delete" }
  | { kind: "replace"; value: unknown }
  | { kind: "object"; entries: Record<string, ConfigDelta> };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function cloneConfigValue<T>(value: T): T {
  return structuredClone(value);
}

function diffObjectConfig(golden: Record<string, unknown>, current: Record<string, unknown>): ConfigDelta | undefined {
  const entries = Object.create(null) as Record<string, ConfigDelta>;
  const keys = new Set([...Object.keys(golden), ...Object.keys(current)]);

  for (const key of keys) {
    const hasGolden = Object.prototype.hasOwnProperty.call(golden, key);
    const hasCurrent = Object.prototype.hasOwnProperty.call(current, key);

    if (hasGolden && !hasCurrent) {
      entries[key] = { kind: "delete" };
      continue;
    }

    if (!hasGolden && hasCurrent) {
      entries[key] = { kind: "replace", value: cloneConfigValue(current[key]) };
      continue;
    }

    const childDelta = diffConfig(golden[key], current[key]);
    if (childDelta) entries[key] = childDelta;
  }

  return Object.keys(entries).length > 0 ? { kind: "object", entries } : undefined;
}

function setOwnDataProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

export function diffConfig(golden: unknown, current: unknown): ConfigDelta | undefined {
  if (isDeepStrictEqual(golden, current)) return undefined;
  if (isObjectRecord(golden) && isObjectRecord(current)) {
    return diffObjectConfig(golden, current);
  }
  return { kind: "replace", value: cloneConfigValue(current) };
}

function applyObjectDelta(
  latest: Record<string, unknown>,
  delta: Extract<ConfigDelta, { kind: "object" }>
): Record<string, unknown> {
  const next = cloneConfigValue(latest);

  for (const [key, childDelta] of Object.entries(delta.entries)) {
    if (childDelta.kind === "delete") {
      delete next[key];
      continue;
    }

    if (childDelta.kind === "replace") {
      setOwnDataProperty(next, key, cloneConfigValue(childDelta.value));
      continue;
    }

    const existing = next[key];
    const base = isObjectRecord(existing) ? existing : {};
    setOwnDataProperty(next, key, applyObjectDelta(base, childDelta));
  }

  return next;
}

export function applyConfigDelta(
  latest: Record<string, unknown>,
  delta: ConfigDelta
): Record<string, unknown> {
  if (delta.kind !== "object") {
    throw new Error("applyConfigDelta requires an object delta at the root");
  }

  return applyObjectDelta(latest, delta);
}
