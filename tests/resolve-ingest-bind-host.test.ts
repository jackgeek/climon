import { describe, expect, test } from "bun:test";
import type { networkInterfaces as NetworkInterfaces } from "node:os";
import { findWslVEthernetIPv4, resolveIngestBindHost } from "../src/remote/ingest-bind-host.js";

type Ifaces = ReturnType<typeof NetworkInterfaces>;

const wslAdapter = {
  "vEthernet (WSL (Hyper-V firewall))": [
    { address: "172.30.192.1", family: "IPv4", internal: false, netmask: "255.255.240.0", mac: "00:00:00:00:00:00", cidr: "172.30.192.1/20" }
  ],
  "vEthernet (Default Switch)": [
    { address: "172.20.0.1", family: "IPv4", internal: false, netmask: "255.255.240.0", mac: "00:00:00:00:00:00", cidr: "172.20.0.1/20" }
  ],
  "Loopback Pseudo-Interface 1": [
    { address: "127.0.0.1", family: "IPv4", internal: true, netmask: "255.0.0.0", mac: "00:00:00:00:00:00", cidr: "127.0.0.1/8" }
  ]
} as unknown as Ifaces;

const noWslAdapter = {
  Ethernet: [
    { address: "10.0.0.5", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: "10.0.0.5/24" }
  ]
} as unknown as Ifaces;

const env = {} as NodeJS.ProcessEnv;

describe("findWslVEthernetIPv4", () => {
  test("returns the WSL vEthernet IPv4, not the Default Switch", () => {
    expect(findWslVEthernetIPv4(wslAdapter)).toBe("172.30.192.1");
  });
  test("returns undefined when no WSL adapter exists", () => {
    expect(findWslVEthernetIPv4(noWslAdapter)).toBeUndefined();
  });
});

describe("resolveIngestBindHost", () => {
  test("an explicit configured host wins over everything", () => {
    expect(
      resolveIngestBindHost(env, {
        configuredHost: () => "10.1.2.3",
        isWsl: () => false,
        interfaces: () => wslAdapter
      })
    ).toBe("10.1.2.3");
  });

  test("WSL host binds loopback (Windows reaches it via localhost-forwarding)", () => {
    expect(
      resolveIngestBindHost(env, { configuredHost: () => undefined, isWsl: () => true, interfaces: () => wslAdapter })
    ).toBe("127.0.0.1");
  });

  test("Windows host binds the vEthernet (WSL) IPv4", () => {
    expect(
      resolveIngestBindHost(env, { configuredHost: () => undefined, isWsl: () => false, interfaces: () => wslAdapter })
    ).toBe("172.30.192.1");
  });

  test("falls back to loopback when no WSL adapter is found (mirrored networking)", () => {
    expect(
      resolveIngestBindHost(env, { configuredHost: () => undefined, isWsl: () => false, interfaces: () => noWslAdapter })
    ).toBe("127.0.0.1");
  });
});
