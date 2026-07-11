import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { zipEntryNamesForPlatform } from "../scripts/compile.js";
import {
  LEGACY_UPDATER_COMMIT,
  assertLegacyLayout,
  assertStubLayout,
  assertUnixLayout,
  currentLayoutKind,
  generateTestKeypair,
  legacyInstalledEntries,
} from "../scripts/upgrade-harness/pack.js";
const testRoot = join(
  process.cwd(),
  ".test-tmp",
  `upgrade-harness-tests-${process.pid}-${Date.now()}`
);
mkdirSync(testRoot, { recursive: true });
afterAll(() => rmSync(testRoot, { recursive: true, force: true }));

describe("released legacy updater fixture", () => {
  test("pins the released v3.1.3 updater commit", () => {
    expect(LEGACY_UPDATER_COMMIT).toBe(
      "3aca69df1420ff4954c4348ccea01980cb681635"
    );
    expect(LEGACY_UPDATER_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });

  test("legacy Unix install contains climon and climon-server", () => {
    expect(legacyInstalledEntries("linux")).toEqual(["climon", "climon-server"]);
    expect(legacyInstalledEntries("darwin")).toEqual(["climon", "climon-server"]);
  });

  test("selects the current layout kind by platform", () => {
    expect(currentLayoutKind("win32")).toBe("windows-stub");
    expect(currentLayoutKind("darwin")).toBe("unix");
    expect(currentLayoutKind("linux")).toBe("unix");
  });
});

describe("current release packaging", () => {
  test("keeps stable archive entries unchanged", () => {
    expect(zipEntryNamesForPlatform("windows-x64")).toEqual([
      "install.exe",
      "climon.dll",
      "climon-server.exe",
    ]);
    expect(zipEntryNamesForPlatform("darwin-arm64")).toEqual([
      "install",
      "climon",
      "climon-server",
    ]);
    expect(zipEntryNamesForPlatform("linux-x64")).toEqual([
      "install",
      "climon",
      "climon-server",
    ]);
  });

  test("honors a scratch Cargo target directory for harness builds", () => {
    const compile = readFileSync("scripts/compile.ts", "utf8");
    const harness = readFileSync("scripts/upgrade-test-harness.ts", "utf8");
    expect(compile).toContain(
      'const cargoTargetDir = resolve(rustDir, process.env.CARGO_TARGET_DIR ?? "target");'
    );
    expect(compile).toContain(
      'resolve(cargoTargetDir, "release", builtName)'
    );
    expect(compile).toContain(
      'resolve(cargoTargetDir, "release", `install${exe}`)'
    );
    expect(harness).toContain(
      'CARGO_TARGET_DIR: join(workRoot, "cargo-current")'
    );
  });
});

describe("test update endpoint isolation", () => {
  test("release workflow never enables the test endpoint", () => {
    const release = readFileSync(".github/workflows/release.yml", "utf8");
    expect(release).not.toContain("CLIMON_TEST_UPDATE_ENDPOINT");
    expect(release).not.toContain("test-update-endpoint");
  });

  test("compile requires explicit opt-in and forwards it to clients and setup", () => {
    const compile = readFileSync("scripts/compile.ts", "utf8");
    expect(compile).toContain(
      'const testUpdateEndpoint = process.env.CLIMON_TEST_UPDATE_ENDPOINT === "1";'
    );
    expect(compile).toContain("const testEndpointArgs = testUpdateEndpoint");
    expect(compile).toContain('? ["--features", "test-update-endpoint"]');
    expect(compile).toContain(
      "cargo build --release -p climon-cli ${testEndpointArgs}"
    );
    expect(compile).toContain(
      "cargo build --release -p climon-dll ${testEndpointArgs}"
    );
    expect(compile).toContain(
      "cargo build --release -p climon-setup ${testEndpointArgs}"
    );
  });

  test("legacy build strips unsupported endpoint, key, and version overrides", () => {
    const harness = readFileSync("scripts/upgrade-test-harness.ts", "utf8");
    for (const name of [
      "CLIMON_TEST_UPDATE_ENDPOINT",
      "CLIMON_TEST_MANIFEST_URL",
      "CLIMON_UPDATE_PUBKEY_B64",
      "CLIMON_VERSION",
      "CARGO_TARGET_DIR",
    ]) {
      expect(harness).toContain(`delete env.${name};`);
    }
  });

  test("cleanup restores a saved dist atomically and keeps cleanup evidence", () => {
    const harness = readFileSync("scripts/upgrade-test-harness.ts", "utf8");
    expect(harness).toContain("renameSync(savedDist, projectDist);");
    expect(harness).toContain("} else if (cleanupErrors.length === 0) {");
  });

  test("cross-platform Rust CI runs the migration harness without endpoint env", () => {
    const rustCi = readFileSync(".github/workflows/rust-ci.yml", "utf8");
    expect(rustCi).toContain("fetch-depth: 0");
    expect(rustCi).toContain("uses: oven-sh/setup-bun@v2");
    expect(rustCi).toContain("run: bun install --frozen-lockfile");
    expect(rustCi).toContain('"scripts/**"');
    expect(rustCi).toContain('"src/**"');
    expect(rustCi).toContain('".github/workflows/release.yml"');
    expect(rustCi).toContain(
      "run: bun test tests/upgrade-harness.test.ts tests/windows-installer-package.test.ts"
    );
    expect(rustCi).toContain("name: Cross-platform legacy update migration");
    expect(rustCi).toContain("run: bun scripts/upgrade-test-harness.ts");
    expect(rustCi).not.toContain("CLIMON_TEST_MANIFEST_URL");
    expect(rustCi).not.toContain("CLIMON_TEST_UPDATE_ENDPOINT");
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
    return mkdtempSync(join(testRoot, "case-"));
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
    expect(() => assertLegacyLayout(dir, "win32")).not.toThrow();
  });

  test("assertLegacyLayout throws when a stub pointer is present", () => {
    const dir = scratch();
    writeFileSync(join(dir, "climon.exe"), "x");
    writeFileSync(join(dir, "climon.version"), "3.2.0");
    expect(() => assertLegacyLayout(dir, "win32")).toThrow(/climon\.version/);
  });

  test("assertUnixLayout requires current binaries and exact version", () => {
    const dir = scratch();
    writeFileSync(join(dir, "climon"), "x");
    writeFileSync(join(dir, "climon-server"), "x");
    writeFileSync(join(dir, ".version"), "3.2.0");
    expect(() => assertUnixLayout(dir, "3.2.0")).not.toThrow();
    expect(() => assertUnixLayout(dir, "3.2.1")).toThrow(/\.version/);
  });
});
