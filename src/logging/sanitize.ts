/**
 * Diagnostic sanitizer for telemetry egress.
 *
 * Error/reason/message strings carry high diagnostic value (error codes,
 * syscalls, HTTP statuses) but also frequently embed identifying values
 * (paths, hostnames, IPs, URLs, emails, tokens). Fully redacting them would
 * make error telemetry useless; this scrubber instead keeps the diagnostic
 * skeleton and replaces only identifier-shaped tokens with typed placeholders.
 *
 * It is applied ONLY on the Application Insights egress path (see
 * `appinsights-transform.ts`); local file and terminal logs always receive the
 * full, unmodified text. When in doubt the scrubber over-redacts: dropping a
 * hostname or a filename is acceptable, leaking one is not.
 */

/** Maximum length of a sanitized diagnostic string before truncation. */
export const MAX_DIAGNOSTIC_LEN = 300;

/**
 * Ordered scrub rules. Order matters: broader structural tokens (URLs, paths)
 * are removed before narrower ones (hostnames) so a URL is not partially
 * rewritten into `<host>/<path>`.
 */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // URLs with any scheme (http, https, ws, file, …).
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<url>"],
  // Email addresses.
  [/\b[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}\b/gi, "<email>"],
  // Windows drive paths (C:\…) and UNC paths (\\server\share).
  [/(?:[a-zA-Z]:\\|\\\\)[^\s"'<>]*/g, "<path>"],
  // POSIX absolute and home/relative paths, anchored to a leading boundary so
  // tokens like "and/or" are left alone.
  [/(^|[\s"'(=:,\[])((?:~|\.{0,2})\/[^\s"'<>)\]]*)/g, "$1<path>"],
  // IPv6: full 8-group form or any `::`-compressed form (avoids clock times).
  [/\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi, "<ip>"],
  [/\b(?:[0-9a-f]{1,4})?(?::[0-9a-f]{1,4})*::(?:[0-9a-f]{1,4})?(?::[0-9a-f]{1,4})*\b/gi, "<ip>"],
  // IPv4 with an optional port.
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, "<ip>"],
  // UUIDs.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
  // hostname/FQDN with an explicit numeric port (host:port).
  [/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9-]+)*:\d{1,5}\b/gi, "<host>"],
  // Bare FQDN (label.label…tld). May also catch dotted filenames; over-redaction
  // is the safe failure mode here.
  [/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi, "<host>"],
  // Long hex blobs (fingerprints, hashes).
  [/\b[0-9a-f]{16,}\b/gi, "<id>"],
  // Long opaque token-ish blobs (base64url-ish).
  [/\b[A-Za-z0-9_-]{24,}\b/g, "<id>"],
];

/**
 * Returns a sanitized copy of a diagnostic string safe for telemetry egress:
 * identifier-shaped tokens are replaced with typed `<placeholder>` markers and
 * the result is truncated. Never returns identifying values on the happy path.
 */
export function sanitizeDiagnostic(value: string): string {
  let out = value;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement);
  }
  if (out.length > MAX_DIAGNOSTIC_LEN) {
    out = `${out.slice(0, MAX_DIAGNOSTIC_LEN)}…`;
  }
  return out;
}
