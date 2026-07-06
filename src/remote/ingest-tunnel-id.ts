import { createHash } from "node:crypto";

/** Shared discovery label applied to the host's ingest tunnel. */
export const INGEST_TUNNEL_LABEL = "climon-ingest";

/**
 * Derives the stable ingest tunnel id from the anonymous install id.
 * Shared contract with the Rust devbox (`derive_ingest_tunnel_id`):
 * `climon-ingest-<first 20 hex of sha256("climon-ingest" + installId)>`.
 */
export function deriveIngestTunnelId(installId: string): string {
  const hex = createHash("sha256").update(`${INGEST_TUNNEL_LABEL}${installId}`, "utf8").digest("hex");
  return `${INGEST_TUNNEL_LABEL}-${hex.slice(0, 20)}`;
}

export interface IngestDescription {
  app: "climon";
  role: "ingest";
  clientId: string;
  hostname: string;
  version: string;
}

/** Builds the non-secret JSON description stored on the ingest tunnel. */
export function buildIngestDescription(input: { clientId: string; hostname: string; version: string }): string {
  const desc: IngestDescription = {
    app: "climon",
    role: "ingest",
    clientId: input.clientId,
    hostname: input.hostname,
    version: input.version
  };
  return JSON.stringify(desc);
}

/** Coerces a hostname to the shared clientId charset, capped at 64 chars. */
export function sanitizeHostForDescription(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const base = cleaned.length > 0 ? cleaned : "host";
  return base.slice(0, 64);
}
