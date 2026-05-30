import { describe, expect, test } from "bun:test";
import { buildSetupCommand } from "../src/web/api.js";

const SETUP = {
  user: "alice",
  sshPort: 22,
  hosts: ["10.0.0.5", "2001:db8::5", "home.example"],
  hostKey: "ssh-ed25519 AAAAC3Nz..."
};

describe("buildSetupCommand", () => {
  test("defaults to the IPv6 address", () => {
    const cmd = buildSetupCommand(SETUP);
    expect(cmd).toContain("climon config remote.enabled true");
    expect(cmd).toContain("climon config remote.host 2001:db8::5");
    expect(cmd).toContain("climon config remote.user alice");
    expect(cmd).toContain("climon config remote.port 22");
    // The pinned known_hosts line is anchored to the SAME host we connect to.
    expect(cmd).toContain("climon config known-host '2001:db8::5 ssh-ed25519 AAAAC3Nz...'");
    // No host-verification bypass leaks into the generated command.
    expect(cmd).not.toContain("StrictHostKeyChecking=no");
  });

  test("selects the IPv4 address when asked", () => {
    const cmd = buildSetupCommand(SETUP, "ipv4");
    expect(cmd).toContain("climon config remote.host 10.0.0.5");
    expect(cmd).toContain("climon config known-host '10.0.0.5 ssh-ed25519 AAAAC3Nz...'");
    expect(cmd).not.toContain("2001:db8::5");
  });

  test("returns IPv6-specific guidance when no IPv6 address exists", () => {
    const cmd = buildSetupCommand({ user: "alice", sshPort: 22, hosts: ["10.0.0.5"], hostKey: "" }, "ipv6");
    expect(cmd).toContain("# No reachable IPv6");
  });

  test("returns IPv4-specific guidance when no IPv4 address exists", () => {
    const cmd = buildSetupCommand({ user: "alice", sshPort: 22, hosts: ["2001:db8::5"], hostKey: "" }, "ipv4");
    expect(cmd).toContain("# No reachable IPv4");
  });
});
