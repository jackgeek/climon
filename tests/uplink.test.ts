import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSingleton, buildSshArgs } from "../src/remote/uplink.js";

describe("buildSshArgs", () => {
  test("emits hardened, non-interactive flags pinned to a known_hosts file", () => {
    const args = buildSshArgs({
      host: "home.example",
      port: 2222,
      user: "alice",
      identityFile: "/d/.climon/id_climon",
      knownHostsFile: "/d/.climon/known_hosts"
    });
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("IdentitiesOnly=yes");
    expect(args).toContain("UserKnownHostsFile=/d/.climon/known_hosts");
    expect(args).toContain("IdentityFile=/d/.climon/id_climon");
    expect(args).toContain("-T");
    expect(args[args.length - 1]).toBe("alice@home.example");
    expect(args).toContain("2222");
    // Never weaken host verification.
    expect(args.join(" ")).not.toContain("StrictHostKeyChecking=no");
    expect(args.join(" ")).not.toContain("StrictHostKeyChecking=accept-new");
  });
});

describe("acquireSingleton", () => {
  test("first acquire wins, second (live pid) is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "climon-uplink-"));
    const pidFile = join(dir, "uplink.pid");
    expect(await acquireSingleton(pidFile)).toBe(true);
    expect(readFileSync(pidFile, "utf8").trim()).toBe(String(process.pid));
    expect(await acquireSingleton(pidFile)).toBe(false);
  });
});
