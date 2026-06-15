import { Transform } from "node:stream";
import { lookupByKey } from "../i18n/catalog.js";
import { SENTINEL_MSG_ID } from "../i18n/log-msg.js";
import type { Catalog, CatalogEntry, MessageParams } from "../i18n/types.js";

/**
 * Transforms pino records into a compact form for Application Insights so the
 * variable, potentially sensitive rendered text never leaves the machine:
 *
 *  - catalogued records (with `msgId`) send the 8-hex id as the trace message
 *    and redact `args` per the catalog's per-parameter metadata;
 *  - uncatalogued records (legacy `logger.x(...)` sites not yet migrated) get a
 *    sentinel id and keep their text for now, per the migration plan.
 */

/** Replaces redacted params with a typed marker; leaves the rest untouched. */
export function redactArgs(
  args: MessageParams,
  entry: CatalogEntry | undefined,
): MessageParams {
  if (!entry) return { ...args };
  const out: MessageParams = {};
  for (const [key, value] of Object.entries(args)) {
    const meta = entry.params[key];
    out[key] = meta?.redact ? `[REDACTED:${meta.category ?? "generic"}]` : value;
  }
  return out;
}

/** Returns a new, compacted copy of a pino record for App Insights. */
export function compactRecord(
  record: Record<string, unknown>,
  catalog: Catalog,
): Record<string, unknown> {
  const out = { ...record };
  const msgId = typeof out.msgId === "string" ? out.msgId : undefined;

  if (msgId) {
    const entry = lookupByKey(catalog, String(out.msgKey ?? ""));
    const args = (out.args ?? {}) as MessageParams;
    out.args = redactArgs(args, entry);
    // The trace message becomes the stable id; the rendered text is discarded.
    out.msg = msgId;
  } else {
    out.msgId = SENTINEL_MSG_ID;
    // Keep the rendered `msg` until the call-site migration is complete.
  }
  return out;
}

/**
 * A Transform that rewrites the NDJSON pino stream line-by-line into compacted
 * records, suitable to pipe into pino-applicationinsights' write stream.
 */
export function createCompactingTransform(catalog: Catalog): Transform {
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
          // Forward unparseable lines unchanged rather than dropping telemetry.
          this.push(`${line}\n`);
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
          this.push(buffer);
        }
        buffer = "";
      }
      cb();
    },
  });
}
