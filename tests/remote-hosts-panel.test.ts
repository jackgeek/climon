import { describe, expect, test } from "bun:test";
import { describeRemoteHost, remoteHostsEmptyLabel } from "../src/web/components/RemoteHostsPanel.js";

describe("RemoteHostsPanel helpers", () => {
  test("describes a healthy host", () => {
    const line = describeRemoteHost({
      clientId: "c1",
      hostname: "box",
      os: "linux",
      address: "10.0.0.7",
      connectedAt: 0,
      sessionCount: 3,
      stale: false,
    });
    expect(line).toBe("box (linux) — 10.0.0.7 — 3 sessions");
  });

  test("empty label when disabled vs none connected", () => {
    expect(remoteHostsEmptyLabel({ remotesActive: false })).toContain("disabled");
    expect(remoteHostsEmptyLabel({ remotesActive: true })).toContain("No remote hosts");
  });
});
