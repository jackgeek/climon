import { describe, expect, test } from "bun:test";
import {
  INGEST_TUNNEL_LABEL,
  deriveIngestTunnelId,
  buildIngestDescription,
  sanitizeHostForDescription
} from "../src/remote/ingest-tunnel-id.js";

describe("ingest tunnel id", () => {
  test("label is the shared constant", () => {
    expect(INGEST_TUNNEL_LABEL).toBe("climon-ingest");
  });

  test("derives the pinned shared test vector", () => {
    expect(deriveIngestTunnelId("00000000-0000-4000-8000-000000000000")).toBe(
      "climon-ingest-f6466583e8b34a25d74d"
    );
  });

  test("derivation is deterministic and stable per install id", () => {
    const a = deriveIngestTunnelId("abc");
    const b = deriveIngestTunnelId("abc");
    expect(a).toBe(b);
    expect(a).not.toBe(deriveIngestTunnelId("abd"));
    expect(a).toMatch(/^climon-ingest-[0-9a-f]{20}$/);
  });

  test("description is non-secret JSON with the fixed shape", () => {
    const json = buildIngestDescription({ clientId: "box1", hostname: "box1", version: "1.2.3" });
    expect(JSON.parse(json)).toEqual({
      app: "climon",
      role: "ingest",
      clientId: "box1",
      hostname: "box1",
      version: "1.2.3"
    });
  });

  test("sanitizes hostnames to the shared charset and cap", () => {
    expect(sanitizeHostForDescription("My Box!!")).toBe("My-Box");
    expect(sanitizeHostForDescription("a".repeat(100)).length).toBe(64);
  });
});
