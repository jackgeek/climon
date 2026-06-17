import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Glob } from "bun";
import { catalogPath, templatePlaceholders, validateCatalog } from "../src/i18n/catalog.js";
import { toCsv, toJsonLookup } from "../src/i18n/publish.js";
import type { Catalog, CatalogEntry, ParamMeta } from "../src/i18n/types.js";

/**
 * Tooling that keeps the message catalog in sync with `logMsg(..)` call sites.
 *
 *   bun run messages:extract  — add missing keys (allocate ids), report orphans.
 *   bun run messages:check    — fail (non-zero) on any drift; used in lint/CI.
 *   bun run messages:publish  — write the flat id/template lookup for log viewers.
 */

const LOGMSG_RE =
  /logMsg\s*\(\s*[^,]+,\s*"(?:trace|debug|info|warn|error|fatal)"\s*,\s*"([^"]+)"/g;

/**
 * Matches user-facing `t("key", ...)` calls. The negative lookbehind excludes
 * identifiers that merely end in `t` (e.g. `split(`, `assert(`, `setTimeout(`)
 * so only the imported catalog helper is treated as a reference.
 */
const TFUNC_RE = /(?<![A-Za-z0-9_$])t\(\s*"([^"]+)"/g;

/** Param names that should almost always be redacted before leaving the machine. */
const SENSITIVE_PARAM_RE =
  /(host|hostname|path|url|user|username|token|secret|password|auth|connectionstring|ip|email)/i;

/**
 * Returns the message keys referenced in source text: the 3rd arg of `logMsg(..)`
 * log calls and the 1st arg of user-facing `t("..")` calls. Both render from the
 * single `messages.en.json` catalog, so both count as references.
 */
export function findMessageKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const m of source.matchAll(LOGMSG_RE)) keys.add(m[1]);
  for (const m of source.matchAll(TFUNC_RE)) keys.add(m[1]);
  return [...keys];
}

/** Allocates a fresh 8-hex id not present in `used`. */
export function allocateId(used: Set<string>): string {
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!used.has(id)) return id;
  }
}

export interface ReconcileResult {
  catalog: Catalog;
  added: string[];
  orphaned: string[];
}

/**
 * Returns a catalog with an entry for every referenced key. New keys get a
 * freshly allocated id and a key-as-template placeholder (to be authored).
 * Existing keys keep their id. Keys in the catalog but not referenced are
 * reported as `orphaned` (not deleted automatically).
 */
export function reconcile(catalog: Catalog, referencedKeys: string[]): ReconcileResult {
  const next: Catalog = { ...catalog };
  const used = new Set(Object.values(catalog).map((e) => e.id));
  const added: string[] = [];

  for (const key of referencedKeys) {
    if (next[key]) continue;
    const id = allocateId(used);
    used.add(id);
    const entry: CatalogEntry = { id, t: key, hint: "", params: {} };
    next[key] = entry;
    added.push(key);
  }

  const referenced = new Set(referencedKeys);
  const orphaned = Object.keys(catalog).filter((k) => !referenced.has(k));
  return { catalog: next, added, orphaned };
}

/** Returns keys referenced in source but missing from the catalog. */
export function checkDrift(catalog: Catalog, referencedKeys: string[]): string[] {
  return referencedKeys.filter((k) => !catalog[k]);
}

/** Returns keys whose translator hint is missing or blank. */
export function missingHintKeys(catalog: Catalog): string[] {
  return Object.entries(catalog)
    .filter(([, e]) => typeof e.hint !== "string" || e.hint.trim() === "")
    .map(([k]) => k);
}

/** Returns warnings for sensitive-looking template params left un-redacted. */
export function sensitiveParamWarnings(catalog: Catalog): string[] {
  const warnings: string[] = [];
  for (const [key, entry] of Object.entries(catalog)) {
    for (const name of templatePlaceholders(entry.t)) {
      const meta = entry.params[name];
      if (SENSITIVE_PARAM_RE.test(name) && meta && meta.redact === false) {
        warnings.push(`${key}: param "${name}" looks sensitive but redact=false`);
      }
    }
  }
  return warnings;
}

/** A catalog fragment authored at migration time: key -> template + hint + params (no id). */
export type CatalogFragment = Record<
  string,
  { t: string; hint?: string; params?: Record<string, ParamMeta> }
>;

export interface MergeResult {
  catalog: Catalog;
  merged: number;
}

/**
 * Merges every `*.json` fragment in `fragDir` into `catalog`. New keys get a
 * freshly allocated id; existing keys keep their id but adopt the fragment's
 * template, hint, and params. Fragments are authored per source file during
 * migration so parallel workers never contend on the single catalog file.
 */
export function mergeFragments(catalog: Catalog, fragDir: string): MergeResult {
  const next: Catalog = { ...catalog };
  const used = new Set(Object.values(next).map((e) => e.id));
  const glob = new Glob("*.json");
  let merged = 0;
  for (const rel of glob.scanSync(fragDir)) {
    const frag = JSON.parse(readFileSync(join(fragDir, rel), "utf8")) as CatalogFragment;
    for (const [key, partial] of Object.entries(frag)) {
      const id = next[key]?.id ?? allocateId(used);
      used.add(id);
      next[key] = {
        id,
        t: partial.t,
        hint: partial.hint ?? next[key]?.hint ?? "",
        params: partial.params ?? {},
      };
      merged++;
    }
  }
  return { catalog: next, merged };
}

/**
 * Applies hint-only fragments (`key -> hint string`) onto an existing catalog,
 * keeping every other field. Throws if a fragment references an unknown key.
 */
export function mergeHintFragments(catalog: Catalog, fragDir: string): MergeResult {
  const next: Catalog = { ...catalog };
  const glob = new Glob("*.json");
  let merged = 0;
  for (const rel of glob.scanSync(fragDir)) {
    const frag = JSON.parse(readFileSync(join(fragDir, rel), "utf8")) as Record<string, string>;
    for (const [key, hint] of Object.entries(frag)) {
      if (!next[key]) throw new Error(`hint fragment "${rel}": unknown key "${key}"`);
      next[key] = { ...next[key], hint };
      merged++;
    }
  }
  return { catalog: next, merged };
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function scanReferencedKeys(): string[] {
  const root = repoRoot();
  const glob = new Glob("src/**/*.ts");
  const keys = new Set<string>();
  for (const rel of glob.scanSync(root)) {
    const text = readFileSync(join(root, rel), "utf8");
    for (const k of findMessageKeys(text)) keys.add(k);
  }
  return [...keys];
}

function loadRawCatalog(): Catalog {
  return JSON.parse(readFileSync(catalogPath(), "utf8")) as Catalog;
}

function writeCatalog(catalog: Catalog): void {
  const sorted: Catalog = {};
  for (const key of Object.keys(catalog).sort()) {
    const e = catalog[key];
    // Stable field order: id, t, hint, params.
    sorted[key] = { id: e.id, t: e.t, hint: e.hint, params: e.params };
  }
  writeFileSync(catalogPath(), `${JSON.stringify(sorted, null, 2)}\n`);
}

function runExtract(): number {
  const keys = scanReferencedKeys();
  const { catalog, added, orphaned } = reconcile(loadRawCatalog(), keys);
  // Newly scaffolded keys have empty hints; don't fail extraction on them.
  validateCatalog(catalog, false);
  writeCatalog(catalog);
  for (const w of sensitiveParamWarnings(catalog)) console.warn(`WARN ${w}`);
  for (const k of missingHintKeys(catalog)) console.warn(`WARN ${k}: missing translation hint`);
  console.log(`messages:extract — ${added.length} added, ${orphaned.length} orphaned`);
  if (added.length) console.log(`  added: ${added.join(", ")}`);
  if (orphaned.length) console.log(`  orphaned (unused): ${orphaned.join(", ")}`);
  return 0;
}

function runCheck(): number {
  const catalog = loadRawCatalog();
  // Structural checks first; hints are reported as a dedicated failure below.
  validateCatalog(catalog, false);
  const keys = scanReferencedKeys();
  const missing = checkDrift(catalog, keys);
  const noHint = missingHintKeys(catalog);
  const warnings = sensitiveParamWarnings(catalog);
  for (const w of warnings) console.warn(`WARN ${w}`);
  if (missing.length) {
    console.error(`messages:check FAILED — ${missing.length} uncatalogued key(s):`);
    for (const k of missing) console.error(`  ${k}`);
    console.error(`Run "bun run messages:extract" to add them.`);
    return 1;
  }
  if (noHint.length) {
    console.error(`messages:check FAILED — ${noHint.length} key(s) missing a translation hint:`);
    for (const k of noHint) console.error(`  ${k}`);
    return 1;
  }
  console.log(`messages:check OK — ${keys.length} keys, ${warnings.length} warning(s)`);
  return 0;
}

function runPublish(): number {
  const catalog = loadRawCatalog();
  validateCatalog(catalog);
  const outDir = join(repoRoot(), "dist");
  mkdirSync(outDir, { recursive: true });
  const csvPath = join(outDir, "messages.en.csv");
  const jsonPath = join(outDir, "messages.en.lookup.json");
  writeFileSync(csvPath, toCsv(catalog));
  writeFileSync(jsonPath, toJsonLookup(catalog));
  console.log(`messages:publish — wrote ${Object.keys(catalog).length} entries`);
  console.log(`  ${csvPath}`);
  console.log(`  ${jsonPath}`);
  return 0;
}

function runMerge(): number {
  const fragDir = join(repoRoot(), ".copilot-tmp", "catalog-fragments");
  const { catalog, merged } = mergeFragments(loadRawCatalog(), fragDir);
  validateCatalog(catalog, false);
  writeCatalog(catalog);
  console.log(`messages:merge — merged ${merged} entries from ${fragDir}`);
  return 0;
}

function runMergeHints(): number {
  const fragDir = join(repoRoot(), ".copilot-tmp", "hint-fragments");
  const { catalog, merged } = mergeHintFragments(loadRawCatalog(), fragDir);
  validateCatalog(catalog);
  writeCatalog(catalog);
  console.log(`messages:hints — applied ${merged} hint(s) from ${fragDir}`);
  return 0;
}

if (import.meta.main) {
  const mode = process.argv[2];
  const run =
    mode === "check"
      ? runCheck
      : mode === "publish"
        ? runPublish
        : mode === "merge"
          ? runMerge
          : mode === "hints"
            ? runMergeHints
            : runExtract;
  process.exit(run());
}
