/** Controlled vocabulary describing what kind of data an interpolated param is. */
export type RedactCategory =
  | "hostname"
  | "path"
  | "url"
  | "config"
  | "pii"
  | "token"
  | "diagnostic"
  | "generic";

/**
 * Metadata for a single interpolated parameter of a message template.
 *
 * `redact: true` scrubs the value before it reaches Application Insights. The
 * scrub behavior depends on `category`: `diagnostic` values (error/reason
 * messages) are passed through {@link sanitizeDiagnostic} so their diagnostic
 * skeleton survives while identifiers are stripped; every other redacted
 * category is replaced with a flat `[REDACTED:<category>]` marker.
 */
export interface ParamMeta {
  /** When true, the value is scrubbed before transmission to Application Insights. */
  redact: boolean;
  /** Data class, used for typed redaction markers and viewer display. */
  category?: RedactCategory;
}

/** A single catalog entry: stable id, template, and per-parameter metadata. */
export interface CatalogEntry {
  /** Stable 8-hex-digit identifier sent to Application Insights. */
  id: string;
  /** Template text with `{named}` placeholders. */
  t: string;
  /**
   * Translator-facing hint: a short note giving the message's context, meaning,
   * tone, or placeholder semantics. Required so the catalog is translatable
   * without reading the source. Analogous to a gettext extracted comment /
   * `msgctxt`, an ICU/Fluent comment, or an Android string `description`.
   */
  hint: string;
  /** Metadata for each placeholder name in `t`. */
  params: Record<string, ParamMeta>;
}

/** The full catalog: symbolic key -> entry. */
export type Catalog = Record<string, CatalogEntry>;

/** Runtime parameter values supplied at a log call site. */
export type MessageParams = Record<string, unknown>;
