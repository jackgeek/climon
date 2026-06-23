import { describe, expect, test } from "bun:test";
import { buildRemotesResponse } from "../src/server/remotes.js";

describe("buildRemotesResponse", () => {
  const now = 2_000_000;

  test("absent status => empty, ingest not running", () => {
    const res = buildRemotesResponse(undefined, now, true, () => true);
    expect(res).toEqual({ connections: [], ingestRunning: false, remotesActive: true });
  });

  test("live status maps connections + staleness", () => {
    const status = {
      pid: 123,
      updatedAt: now,
      connections: [
        {
          clientId: "c1",
          hostname: "box",
          os: "linux",
          address: "10.0.0.7",
          connectedAt: now - 5000,
          sessionCount: 2,
          lastPingAt: now - 1000,
        },
      ],
    };
    const res = buildRemotesResponse(status, now, true, () => true);
    expect(res.ingestRunning).toBe(true);
    expect(res.connections[0]).toMatchObject({
      clientId: "c1",
      hostname: "box",
      stale: false,
      sessionCount: 2,
    });
  });

  test("dead pid => not running and connections marked stale", () => {
    const status = {
      pid: 999,
      updatedAt: now,
      connections: [
        { clientId: "c1", hostname: "box", os: "linux", connectedAt: now, sessionCount: 0 },
      ],
    };
    const res = buildRemotesResponse(status, now, true, () => false);
    expect(res.ingestRunning).toBe(false);
    expect(res.connections[0].stale).toBe(true);
  });
});
