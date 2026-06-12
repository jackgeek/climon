import { describe, expect, test } from "bun:test";
import { planUplinkStart } from "../src/launcher.js";

describe("planUplinkStart", () => {
  const remoteConfig = {
    enabled: true,
    tunnelId: "spiffy-chair-c2lj709.eun1"
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

  test("spawns detached uplink for direct host config without devtunnel", () => {
    expect(planUplinkStart({ enabled: true, host: "172.30.192.1", port: 3132 }, { available: false })).toEqual({
      shouldSpawn: true
    });
  });

  test("does nothing when remote config is incomplete", () => {
    expect(planUplinkStart({ enabled: false }, { available: false })).toEqual({ shouldSpawn: false });
  });

  test("does nothing when only enabled but no tunnel or host", () => {
    expect(planUplinkStart({ enabled: true }, { available: true })).toEqual({ shouldSpawn: false });
  });
});
