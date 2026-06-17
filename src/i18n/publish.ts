import { templatePlaceholders } from "./catalog.js";
import type { Catalog } from "./types.js";

/**
 * Publishing the message catalog as a flat lookup for cloud log viewers.
 *
 * Application Insights receives only the 8-hex `msgId` (see the compacting
 * transform), never the rendered text. A viewer — Azure Monitor Workbook /
 * Grafana with the Azure Monitor source, joining via KQL `externaldata`, or
 * Seq — re-attaches the human-readable template at view time by joining on the
 * id. These helpers turn the catalog into the flat `id,template,...` table such
 * a join expects. We own only the publishing of this lookup; the viewer and its
 * Azure RBAC are external.
 */

/** One row of the published catalog lookup. */
export interface LookupRow {
  /** 8-hex id sent to Application Insights as the trace message. */
  id: string;
  /** Symbolic catalog key (stable, human-meaningful). */
  key: string;
  /** Template text with `{named}` placeholders. */
  template: string;
  /** Translator-facing context hint. */
  hint: string;
  /** Comma-joined placeholder names, in template order, e.g. "host,port". */
  params: string;
  /** Comma-joined subset of `params` that are redacted before transmission. */
  redacted: string;
}

/**
 * Flattens the catalog into lookup rows sorted by key for deterministic output
 * (stable diffs and stable published artifacts).
 */
export function toLookupRows(catalog: Catalog): LookupRow[] {
  return Object.keys(catalog)
    .sort()
    .map((key) => {
      const entry = catalog[key];
      const names = templatePlaceholders(entry.t);
      const redacted = names.filter((name) => entry.params[name]?.redact === true);
      return {
        id: entry.id,
        key,
        template: entry.t,
        hint: entry.hint,
        params: names.join(","),
        redacted: redacted.join(","),
      };
    });
}

/** Escapes one field for RFC-4180 CSV (quote when it contains , " or newline). */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Renders the lookup as CSV with a header row. Consumed by KQL
 * `externaldata(...) with(format='csv', ignoreFirstRecord=true)`.
 */
export function toCsv(catalog: Catalog): string {
  const header = "id,key,template,hint,params,redacted";
  const rows = toLookupRows(catalog).map((r) =>
    [r.id, r.key, r.template, r.hint, r.params, r.redacted].map(csvField).join(","),
  );
  return `${[header, ...rows].join("\n")}\n`;
}

/** Renders the lookup as a JSON array of {@link LookupRow}. */
export function toJsonLookup(catalog: Catalog): string {
  return `${JSON.stringify(toLookupRows(catalog), null, 2)}\n`;
}
