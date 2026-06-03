import { describe, expect, test } from "bun:test";
import { planUplinkStart, reconnectBanner } from "../src/launcher.js";
import { VERSION } from "../src/version.js";

describe("planUplinkStart", () => {
  const remoteConfig = {
    enabled: true,
    tunnelId: "spiffy-chair-c2lj709.eun1",
    tunnelToken: "token",
    port: 3132
  };

  test("warns and skips detached uplink when devtunnel is unavailable", () => {
    expect(planUplinkStart(remoteConfig, { available: false })).toEqual({
      shouldSpawn: false,
      warning:
        "climon: remote monitoring is configured, but the devtunnel CLI is not installed or not runnable on this machine. Install devtunnel for sessions to appear on the remote dashboard.\n"
    });
  });

  test("spawns detached uplink when remote config and devtunnel are available", () => {
    expect(planUplinkStart(remoteConfig, { available: true, version: "Tunnel CLI version: 1.0.1886" })).toEqual({
      shouldSpawn: true
    });
  });

  test("does nothing when remote config is incomplete", () => {
    expect(planUplinkStart({ enabled: false }, { available: false })).toEqual({ shouldSpawn: false });
  });
});

describe("reconnectBanner", () => {
  test("includes the climon version when attaching to an existing session", () => {
    expect(reconnectBanner("abc123")).toBe(`climon v${VERSION} connecting to session abc123\r\n`);
  });
});
