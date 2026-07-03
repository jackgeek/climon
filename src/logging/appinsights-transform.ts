import { Transform } from "node:stream";
import { lookupByKey } from "../i18n/catalog.js";
import { SENTINEL_MSG_ID } from "../i18n/log-msg.js";
import type { Catalog, CatalogEntry } from "../i18n/types.js";
import { sanitizeDiagnostic } from "./sanitize.js";

/**
 * Transforms pino records into a compact form for Application Insights so the
 * variable, potentially sensitive rendered text never leaves the machine.
 *
 * Emission is allowlist-based: only a fixed set of non-identifying base fields
 * plus the record's own catalog parameters (redacted/sanitized per the catalog)
 * are ever forwarded. Everything else — the rendered `msg`, serialized errors,
 * and any stray properties — is dropped.
 *
 *  - catalogued records (with a real `msgId`) send the 8-hex id as the trace
 *    message and their redacted/sanitized catalog params as flat properties;
 *  - uncatalogued records (no `msgId`, or the sentinel id for a not-yet-migrated
 *    `logMsg` key) send only the sentinel id and the allowlisted base fields —
 *    their rendered text is never transmitted.
 */

/**
 * Non-identifying top-level fields that are always safe to forward. Catalog
 * parameters are added on top of this per-record for catalogued entries.
 */
const BASE_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "level",
  "time",
  "role",
  "pid",
  "version",
  "installId",
  "component",
  "msgId",
  "msgKey",
]);

/** Returns a copy of `record` containing only the keys in `allowed`. */
function pickAllowed(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Returns a copy of `record` with each redact:true catalog parameter present at
 * the top level scrubbed. `diagnostic` params are sanitized (their diagnostic
 * skeleton is kept, identifiers stripped); every other redacted category is
 * replaced by a flat `[REDACTED:<category>]` marker. Other fields are untouched.
 */
export function redactParams(
  record: Record<string, unknown>,
  entry: CatalogEntry | undefined,
): Record<string, unknown> {
  const out = { ...record };
  if (!entry) return out;
  for (const [name, meta] of Object.entries(entry.params)) {
    if (!meta.redact || !Object.prototype.hasOwnProperty.call(out, name)) continue;
    if (meta.category === "diagnostic") {
      if (typeof out[name] === "string") out[name] = sanitizeDiagnostic(out[name] as string);
    } else {
      out[name] = `[REDACTED:${meta.category ?? "generic"}]`;
    }
  }
  return out;
}

/** Returns a new, compacted copy of a pino record for App Insights. */
export function compactRecord(
  record: Record<string, unknown>,
  catalog: Catalog,
): Record<string, unknown> {
  const msgId = typeof record.msgId === "string" ? record.msgId : undefined;
  const entry = msgId ? lookupByKey(catalog, String(record.msgKey ?? "")) : undefined;

  // Uncatalogued (no msgId) or a sentinel/unknown key with no catalog entry:
  // forward only the allowlisted base fields and stamp the sentinel id, so no
  // rendered text or stray property can leak.
  if (!entry) {
    const out = pickAllowed(record, BASE_ALLOWED_FIELDS);
    out.msgId = SENTINEL_MSG_ID;
    out.msg = SENTINEL_MSG_ID;
    return out;
  }

  // Catalogued: keep base fields plus this entry's (redacted/sanitized) params;
  // the trace message becomes the stable id and the rendered text is discarded.
  const redacted = redactParams(record, entry);
  const allowed = new Set(BASE_ALLOWED_FIELDS);
  for (const name of Object.keys(entry.params)) allowed.add(name);
  const out = pickAllowed(redacted, allowed);
  out.msg = msgId;
  return out;
}

/**
 * A Transform that rewrites the NDJSON pino stream line-by-line into compacted
 * records, suitable to pipe into pino-applicationinsights' write stream.
 */
export function createCompactingTransform(catalog: Catalog): Transform {
  // A minimal record emitted when a line cannot be parsed, so a dropped record
  // is still observable in telemetry without forwarding any raw text.
  const sentinelLine = `${JSON.stringify({ msgId: SENTINEL_MSG_ID, msg: SENTINEL_MSG_ID })}\n`;
  let buffer = "";
  return new Transform({
    transform(chunk, _enc, cb) {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        try {
          const compacted = compactRecord(JSON.parse(line), catalog);
          this.push(`${JSON.stringify(compacted)}\n`);
        } catch {
          // Never forward an unparseable line's raw text; emit a sentinel instead.
          this.push(sentinelLine);
        }
      }
      cb();
    },
    flush(cb) {
      if (buffer.trim() !== "") {
        try {
          const compacted = compactRecord(JSON.parse(buffer), catalog);
          this.push(`${JSON.stringify(compacted)}\n`);
        } catch {
          this.push(sentinelLine);
        }
        buffer = "";
      }
      cb();
    },
  });
}
