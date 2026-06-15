import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Catalog, CatalogEntry, MessageParams } from "./types.js";

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;
const ID_RE = /^[0-9a-f]{8}$/;

/** Absolute path to the English source catalog. */
export function catalogPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "messages.en.json");
}

let cached: Catalog | undefined;

/** Loads (and caches) the English catalog from disk. */
export function loadCatalog(): Catalog {
  if (!cached) {
    cached = JSON.parse(readFileSync(catalogPath(), "utf8")) as Catalog;
  }
  return cached;
}

/** Test helper: drops the cached catalog so the next load re-reads disk. */
export function resetCatalogCacheForTests(): void {
  cached = undefined;
}

/** Returns the placeholder names referenced by a template, in order, de-duplicated. */
export function templatePlaceholders(template: string): string[] {
  const names = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER_RE)) names.add(m[1]);
  return [...names];
}

/** Returns the catalog entry for a key, or undefined. */
export function lookupByKey(catalog: Catalog, key: string): CatalogEntry | undefined {
  return Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : undefined;
}

/**
 * Substitutes `{named}` placeholders in a template with param values. Missing
 * params are left as their literal placeholder so gaps are visible, not silent.
 */
export function renderTemplate(template: string, params: MessageParams): string {
  return template.replace(PLACEHOLDER_RE, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return whole;
    const value = params[name];
    return value === undefined || value === null ? whole : String(value);
  });
}

/**
 * Resolves a key + params to full rendered text. Falls back to the key itself
 * when the key is not in the catalog (keeps logging resilient during migration).
 */
export function renderMessage(catalog: Catalog, key: string, params: MessageParams): string {
  const entry = lookupByKey(catalog, key);
  if (!entry) return key;
  return renderTemplate(entry.t, params);
}

/**
 * Validates structural invariants of a catalog. Throws on the first problem:
 * non-8-hex ids, duplicate ids, or a template placeholder lacking param metadata.
 */
export function validateCatalog(catalog: Catalog): void {
  const seenIds = new Map<string, string>();
  for (const [key, entry] of Object.entries(catalog)) {
    if (!ID_RE.test(entry.id)) {
      throw new Error(`catalog key "${key}": id "${entry.id}" must be 8 hex digits`);
    }
    const prev = seenIds.get(entry.id);
    if (prev) {
      throw new Error(`catalog: duplicate id "${entry.id}" on keys "${prev}" and "${key}"`);
    }
    seenIds.set(entry.id, key);

    for (const name of templatePlaceholders(entry.t)) {
      if (!entry.params || !Object.prototype.hasOwnProperty.call(entry.params, name)) {
        throw new Error(
          `catalog key "${key}": template placeholder "{${name}}" has no params metadata`,
        );
      }
    }
  }
}
