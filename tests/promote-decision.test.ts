import { describe, expect, test } from "bun:test";
import { runPromote, type PromoteDeps } from "../src/server/promote.js";

function baseDeps(overrides: Partial<PromoteDeps> = {}): PromoteDeps {
  return {
    peerLabel: "WSL",
    readPeerServer: async () => undefined,
    readPeerIngest: async () => undefined,
    probeIngestListening: async () => false,
    writeShutdownRequest: async () => {},
    confirmDemoted: async () => true,
    clearPeerBeacons: async () => {},
    ...overrides
  };
}

describe("runPromote (filesystem matrix)", () => {
  test("no peer beacons → proceed (no-live-peer)", async () => {
    const out = await runPromote(baseDeps());
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") expect(out.via).toBe("no-live-peer");
  });

  test("peer ingest present but not listening → clear stale beacons, proceed", async () => {
    let cleared = false;
    const out = await runPromote(
      baseDeps({
        readPeerIngest: async () => ({ port: 3132, host: "127.0.0.1" }),
        probeIngestListening: async () => false,
        clearPeerBeacons: async () => { cleared = true; }
      })
    );
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") expect(out.via).toBe("no-live-peer");
    expect(cleared).toBe(true);
  });

  test("peer ingest listening, demoted within grace → proceed (graceful)", async () => {
    let writes = 0;
    const out = await runPromote(
      baseDeps({
        readPeerIngest: async () => ({ port: 3132, host: "172.30.192.1" }),
        probeIngestListening: async () => true,
        writeShutdownRequest: async () => { writes += 1; },
        confirmDemoted: async () => true
      })
    );
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") expect(out.via).toBe("graceful");
    expect(writes).toBe(1);
  });

  test("peer ingest listening, never demotes → abort (cleanup on peer)", async () => {
    const out = await runPromote(
      baseDeps({
        readPeerIngest: async () => ({ port: 3132 }),
        probeIngestListening: async () => true,
        confirmDemoted: async () => false
      })
    );
    expect(out.kind).toBe("aborted");
    if (out.kind === "aborted") expect(out.cleanupOn).toBe("WSL");
  });

  test("peer server.json present but no ingest beacon → abort", async () => {
    const out = await runPromote(
      baseDeps({ readPeerServer: async () => ({ port: 3131 }), readPeerIngest: async () => undefined })
    );
    expect(out.kind).toBe("aborted");
    if (out.kind === "aborted") expect(out.cleanupOn).toBe("WSL");
  });

  test("no beacons ⇒ the probe is never called", async () => {
    let probed = false;
    await runPromote(baseDeps({ probeIngestListening: async () => { probed = true; return false; } }));
    expect(probed).toBe(false);
  });

  test("emits diagnostic log lines describing the decision", async () => {
    const lines: string[] = [];
    await runPromote(
      baseDeps({
        log: (m) => lines.push(m),
        readPeerIngest: async () => ({ port: 3132, host: "127.0.0.1" }),
        probeIngestListening: async () => true,
        confirmDemoted: async () => true
      })
    );
    const text = lines.join("\n");
    expect(text).toContain("peer beacons:");
    expect(text).toContain("shutdown-request");
    expect(text).toContain("demoted");
  });
});
