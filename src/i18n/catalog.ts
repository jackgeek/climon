import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import bundledCatalog from "./messages.en.json";
import type { Catalog, CatalogEntry, MessageParams } from "./types.js";

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;
const ID_RE = /^[0-9a-f]{8}$/;

/**
 * Absolute path to the English source catalog on disk. Used by build-time
 * tooling (extract/merge/publish); the runtime loader uses the bundled import
 * below so compiled client/server binaries need no catalog file at runtime.
 */
export function catalogPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "messages.en.json");
}

let cached: Catalog | undefined;

/**
 * Returns the English catalog. The catalog is statically imported so the
 * bundler embeds it into both binaries — runtime logging never touches disk and
 * cannot fail when the source JSON is absent from a compiled binary.
 */
export function loadCatalog(): Catalog {
  if (!cached) cached = bundledCatalog as Catalog;
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
 * non-8-hex ids, duplicate ids, a template placeholder lacking param metadata,
 * or (when `requireHints`) an entry missing its translator hint.
 *
 * `requireHints` defaults to true; build tooling passes false while scaffolding
 * new keys whose hints have not been authored yet.
 */
export function validateCatalog(catalog: Catalog, requireHints = true): void {
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

    if (requireHints && (typeof entry.hint !== "string" || entry.hint.trim() === "")) {
      throw new Error(`catalog key "${key}": missing required translation hint`);
    }

    for (const name of templatePlaceholders(entry.t)) {
      if (!entry.params || !Object.prototype.hasOwnProperty.call(entry.params, name)) {
        throw new Error(
          `catalog key "${key}": template placeholder "{${name}}" has no params metadata`,
        );
      }
    }
  }
}
