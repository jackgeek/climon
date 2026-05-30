import { describe, expect, test } from "bun:test";
import { buildSetupCommand } from "../src/web/api.js";

describe("buildSetupCommand", () => {
  test("produces a single climon config + enroll command with the host pinned", () => {
    const cmd = buildSetupCommand({
      user: "alice",
      sshPort: 22,
      hosts: ["home.example", "10.0.0.5"],
      hostKey: "home.example ssh-ed25519 AAAAC3Nz..."
    });
    expect(cmd).toContain("climon config remote.enabled true");
    expect(cmd).toContain("climon config remote.host home.example");
    expect(cmd).toContain("climon config remote.user alice");
    expect(cmd).toContain("climon config remote.port 22");
    // No host-verification bypass leaks into the generated command.
    expect(cmd).not.toContain("StrictHostKeyChecking=no");
  });

  test("returns a guidance string when no host is known", () => {
    const cmd = buildSetupCommand({ user: "alice", sshPort: 22, hosts: [], hostKey: "" });
    expect(cmd).toContain("# No reachable host");
  });
});
