import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addManagedKey,
  authorizeClient,
  buildAuthorizedKeysEntry,
  listClients,
  listManagedClients,
  orderHostCandidates,
  parsePublicKey,
  revokeClient,
  revokeManagedClient,
  sanitizeLabel
} from "../src/remote/enroll.js";

const ED = "ssh-ed25519";
const BODY = "AAAAC3NzaC1lZDI1NTE5AAAAIO".padEnd(68, "A"); // 68 chars, multiple of 4

describe("parsePublicKey", () => {
  test("parses an ed25519 key and captures the comment", () => {
    const parsed = parsePublicKey(`${ED} ${BODY} user@host`);
    expect(parsed.type).toBe(ED);
    expect(parsed.base64).toBe(BODY);
    expect(parsed.comment).toBe("user@host");
  });
  test("rejects an unknown key type", () => {
    expect(() => parsePublicKey(`ssh-dss ${BODY} x`)).toThrow();
  });
  test("rejects a non-base64 body", () => {
    expect(() => parsePublicKey(`${ED} not*base64!! x`)).toThrow();
  });
  test("rejects input with embedded newlines", () => {
    expect(() => parsePublicKey(`${ED} ${BODY} x\ncommand="evil"`)).toThrow();
  });
});

describe("sanitizeLabel", () => {
  test("accepts safe labels", () => {
    expect(sanitizeLabel("devbox-1.eu")).toBe("devbox-1.eu");
  });
  test("rejects shell metacharacters", () => {
    expect(() => sanitizeLabel('a";rm -rf /')).toThrow();
    expect(() => sanitizeLabel("a b")).toThrow();
    expect(() => sanitizeLabel("a$b")).toThrow();
  });
});

describe("buildAuthorizedKeysEntry", () => {
  test("reconstructs a forced-command restricted line and drops the raw comment", () => {
    const parsed = parsePublicKey(`${ED} ${BODY} pwned",command="evil"`);
    const entry = buildAuthorizedKeysEntry(parsed, "devbox-1");
    expect(entry).toBe(
      `command="climon-server --ssh-accept --label devbox-1",restrict ${ED} ${BODY} climon:devbox-1`
    );
    expect(entry).not.toContain("evil");
  });
});

describe("managed block", () => {
  const parsed = parsePublicKey(`${ED} ${BODY} x`);

  test("adds within markers and is idempotent per label", () => {
    let content = addManagedKey("# existing user key\n", parsed, "box-a");
    expect(content).toContain("# climon-managed BEGIN");
    expect(content).toContain("# climon-managed END");
    expect(content).toContain("# existing user key");
    const again = addManagedKey(content, parsed, "box-a");
    expect(again.match(/climon:box-a/g)?.length).toBe(1);
  });

  test("lists managed clients", () => {
    const content = addManagedKey(addManagedKey("", parsed, "box-a"), parsed, "box-b");
    const clients = listManagedClients(content);
    expect(clients.map((c) => c.label).sort()).toEqual(["box-a", "box-b"]);
    expect(clients[0].type).toBe(ED);
  });

  test("revokes a single client and preserves others and outside keys", () => {
    let content = addManagedKey("# user key\n", parsed, "box-a");
    content = addManagedKey(content, parsed, "box-b");
    content = revokeManagedClient(content, "box-a");
    expect(content).toContain("# user key");
    expect(content).not.toContain("climon:box-a");
    expect(content).toContain("climon:box-b");
  });

  test("removes the marker block entirely when last client revoked", () => {
    const content = revokeManagedClient(addManagedKey("# user key\n", parsed, "box-a"), "box-a");
    expect(content).not.toContain("# climon-managed BEGIN");
    expect(content).toContain("# user key");
  });
});

describe("enrollment service", () => {
  test("authorize, list (with fingerprint), and revoke against a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "climon-ak-"));
    const path = join(dir, "authorized_keys");
    const key = `${ED} ${BODY} pasted-comment`;
    await authorizeClient("box-a", parsePublicKey(key), path);
    let clients = await listClients(path);
    expect(clients.map((c) => c.label)).toEqual(["box-a"]);
    expect(clients[0].keyType).toBe(ED);
    expect(clients[0].fingerprint.startsWith("SHA256:")).toBe(true);
    expect(await revokeClient("box-a", path)).toBe(true);
    expect(await revokeClient("box-a", path)).toBe(false);
    clients = await listClients(path);
    expect(clients).toEqual([]);
  });
});

describe("orderHostCandidates", () => {
  const ifaces = [
    { address: "127.0.0.1", family: "IPv4", internal: true },
    { address: "::1", family: "IPv6", internal: true },
    { address: "192.168.1.50", family: "IPv4", internal: false },
    { address: "fe80::1", family: "IPv6", internal: false },
    { address: "2001:db8::5", family: "IPv6", internal: false }
  ];

  test("puts a routable IPv4 address first so the setup command never relies on the hostname", () => {
    const hosts = orderHostCandidates("my-laptop.local", ifaces);
    expect(hosts[0]).toBe("192.168.1.50");
    expect(hosts).not.toContain("127.0.0.1");
    expect(hosts).not.toContain("::1");
    // IPv6 link-local is unusable without a scope id, so it is dropped.
    expect(hosts).not.toContain("fe80::1");
    // The hostname remains only as a last-resort fallback.
    expect(hosts).toContain("my-laptop.local");
    expect(hosts.indexOf("192.168.1.50")).toBeLessThan(hosts.indexOf("my-laptop.local"));
  });

  test("falls back to the hostname only when no external IP exists", () => {
    const hosts = orderHostCandidates("my-laptop.local", [
      { address: "127.0.0.1", family: "IPv4", internal: true }
    ]);
    expect(hosts).toEqual(["my-laptop.local"]);
  });
});
