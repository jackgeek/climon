import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipEntryNamesForPlatform } from "../scripts/compile.js";
import {
  assertLegacyLayout,
  assertStubLayout,
  generateTestKeypair,
} from "../scripts/upgrade-harness/pack.js";

describe("legacy layout packaging", () => {
  test("legacy Windows zip has climon.exe + climon-server.exe and no dll/installer", () => {
    const names = zipEntryNamesForPlatform("windows-x64", { legacy: true });
    expect(names).toEqual(["climon.exe", "climon-server.exe"]);
    expect(names).not.toContain("climon.dll");
    expect(names).not.toContain("install.exe");
  });

  test("stub Windows zip is unchanged (install.exe + climon.dll + server)", () => {
    const names = zipEntryNamesForPlatform("windows-x64");
    expect(names).toEqual(["install.exe", "climon.dll", "climon-server.exe"]);
  });
});

describe("test keypair", () => {
  test("generates a raw Ed25519 public key and a PKCS8 private key, both base64", async () => {
    const kp = await generateTestKeypair();
    // raw Ed25519 public key is 32 bytes -> 44 base64 chars incl. padding
    expect(Buffer.from(kp.publicKeyRawB64, "base64").length).toBe(32);
    // PKCS8 private key decodes to a non-trivial DER blob
    expect(Buffer.from(kp.privateKeyPkcs8B64, "base64").length).toBeGreaterThan(32);
  });
});

describe("layout assertions", () => {
  function scratch(): string {
    return mkdtempSync(join(tmpdir(), "climon-harness-"));
  }

  test("assertStubLayout passes on a complete stub install dir", () => {
    const dir = scratch();
    for (const f of [
      "climon.exe",
      "climon-server.exe",
      "climon-3.2.0.dll",
      "climon-server-3.2.0.exe",
    ]) {
      writeFileSync(join(dir, f), "x");
    }
    writeFileSync(join(dir, "climon.version"), "3.2.0");
    writeFileSync(join(dir, "climon-server.version"), "3.2.0");
    expect(() => assertStubLayout(dir, "3.2.0")).not.toThrow();
  });

  test("assertStubLayout throws when the pointer is missing", () => {
    const dir = scratch();
    writeFileSync(join(dir, "climon.exe"), "x");
    expect(() => assertStubLayout(dir, "3.2.0")).toThrow(/climon\.version/);
  });

  test("assertLegacyLayout passes on a single-exe install with no pointer", () => {
    const dir = scratch();
    writeFileSync(join(dir, "climon.exe"), "x");
    writeFileSync(join(dir, "climon-server.exe"), "x");
    expect(() => assertLegacyLayout(dir)).not.toThrow();
  });

  test("assertLegacyLayout throws when a stub pointer is present", () => {
    const dir = scratch();
    writeFileSync(join(dir, "climon.exe"), "x");
    writeFileSync(join(dir, "climon.version"), "3.2.0");
    expect(() => assertLegacyLayout(dir)).toThrow(/climon\.version/);
  });
});
