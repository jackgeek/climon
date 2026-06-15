import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Glob } from "bun";
import { catalogPath, templatePlaceholders, validateCatalog } from "../src/i18n/catalog.js";
import { toCsv, toJsonLookup } from "../src/i18n/publish.js";
import type { Catalog, CatalogEntry } from "../src/i18n/types.js";

/**
 * Tooling that keeps the message catalog in sync with `logMsg(..)` call sites.
 *
 *   bun run messages:extract  — add missing keys (allocate ids), report orphans.
 *   bun run messages:check    — fail (non-zero) on any drift; used in lint/CI.
 *   bun run messages:publish  — write the flat id/template lookup for log viewers.
 */

const LOGMSG_RE =
  /logMsg\s*\(\s*[^,]+,\s*"(?:trace|debug|info|warn|error|fatal)"\s*,\s*"([^"]+)"/g;

/** Param names that should almost always be redacted before leaving the machine. */
const SENSITIVE_PARAM_RE =
  /(host|hostname|path|url|user|username|token|secret|password|auth|connectionstring|ip|email)/i;

/** Returns the message keys (3rd arg) referenced by `logMsg(..)` in source text. */
export function findMessageKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const m of source.matchAll(LOGMSG_RE)) keys.add(m[1]);
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
    const entry: CatalogEntry = { id, t: key, params: {} };
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
  for (const key of Object.keys(catalog).sort()) sorted[key] = catalog[key];
  writeFileSync(catalogPath(), `${JSON.stringify(sorted, null, 2)}\n`);
}

function runExtract(): number {
  const keys = scanReferencedKeys();
  const { catalog, added, orphaned } = reconcile(loadRawCatalog(), keys);
  validateCatalog(catalog);
  writeCatalog(catalog);
  for (const w of sensitiveParamWarnings(catalog)) console.warn(`WARN ${w}`);
  console.log(`messages:extract — ${added.length} added, ${orphaned.length} orphaned`);
  if (added.length) console.log(`  added: ${added.join(", ")}`);
  if (orphaned.length) console.log(`  orphaned (unused): ${orphaned.join(", ")}`);
  return 0;
}

function runCheck(): number {
  const catalog = loadRawCatalog();
  validateCatalog(catalog);
  const keys = scanReferencedKeys();
  const missing = checkDrift(catalog, keys);
  const warnings = sensitiveParamWarnings(catalog);
  for (const w of warnings) console.warn(`WARN ${w}`);
  if (missing.length) {
    console.error(`messages:check FAILED — ${missing.length} uncatalogued key(s):`);
    for (const k of missing) console.error(`  ${k}`);
    console.error(`Run "bun run messages:extract" to add them.`);
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

if (import.meta.main) {
  const mode = process.argv[2];
  const run = mode === "check" ? runCheck : mode === "publish" ? runPublish : runExtract;
  process.exit(run());
}
