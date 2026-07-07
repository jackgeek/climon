#!/usr/bin/env bun
/**
 * End-to-end Windows upgrade-test harness for the Feature 2 binary lifecycle.
 *
 * Runs on a REAL Windows box (the migration paths are #[cfg(windows)]-only). It:
 *   1. generates a throwaway Ed25519 keypair,
 *   2. builds a scratch `climon` client with --features test-update-endpoint and the
 *      test public key embedded (CLIMON_UPDATE_PUBKEY_B64),
 *   3. packages a bridge zip (legacy layout) and a C zip (stub layout) at version V,
 *      and a C+1 stub zip at version V2,
 *   4. signs them with the test private key via signReleaseDir + serves over loopback,
 *   5. drives: bridge->C migration, C->C+1 stub update, idempotent --migrate, and
 *      simulated-brick recovery, asserting on-disk layout after each.
 *
 * SECURITY: never reads the production signing key; the test feature/pubkey override are
 * never used by the release pipeline. See the plan's "Security invariants".
 */
import { $ } from "bun";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { signReleaseDir } from "./sign-release.js";
import {
  generateTestKeypair,
  assertStubLayout,
  assertLegacyLayout,
  serveDir,
} from "./upgrade-harness/pack.js";

if (process.platform !== "win32") {
  console.error("upgrade-test-harness must run on Windows (migration is #[cfg(windows)]).");
  process.exit(2);
}

const projectRoot = dirname(import.meta.dir);
const rustDir = resolve(projectRoot, "rust");
const V = "9.9.0"; // C release version (well above any real version)
const V2 = "9.9.1"; // C+1 release version

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `climon-${prefix}-`));
}

/** Unzips a harness zip into `dest` using PowerShell's Expand-Archive. */
async function unzipInto(zip: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  await $`powershell -NoProfile -Command Expand-Archive -Path ${zip} -DestinationPath ${dest} -Force`;
}

async function main() {
  const kp = await generateTestKeypair();
  const workRoot = scratch("work");
  console.log(`harness work dir: ${workRoot}`);

  // 1. Build the scratch test client (feature-gated override + test pubkey embedded).
  console.log("→ Building scratch test client (climon-cli, test-update-endpoint)...");
  await $`cargo build --release -p climon-cli --features test-update-endpoint`
    .env({ ...process.env, CLIMON_UPDATE_PUBKEY_B64: kp.publicKeyRawB64, CLIMON_VERSION: V })
    .cwd(rustDir);

  // 2. Build the release zips: bridge (legacy) + C (stub) at V, plus C+1 (stub) at V2.
  const releaseDir = join(workRoot, "release");
  mkdirSync(releaseDir, { recursive: true });

  console.log("→ Packaging bridge (legacy) zip...");
  await $`bun ${resolve(projectRoot, "scripts/compile.ts")}`.env({
    ...process.env,
    CLIMON_LEGACY_LAYOUT: "1",
    CLIMON_VERSION: V,
    CLIMON_UPDATE_PUBKEY_B64: kp.publicKeyRawB64,
  });
  const bridgeZip = join(releaseDir, "bridge-climon-windows-x64.zip");
  cpSync(resolve(projectRoot, "dist", "climon-windows-x64.zip"), bridgeZip);

  console.log(`→ Packaging C (stub) zip at ${V}...`);
  await $`bun ${resolve(projectRoot, "scripts/compile.ts")}`.env({
    ...process.env,
    CLIMON_VERSION: V,
    CLIMON_UPDATE_PUBKEY_B64: kp.publicKeyRawB64,
  });
  const cDir = join(workRoot, "serve-c");
  mkdirSync(cDir, { recursive: true });
  cpSync(
    resolve(projectRoot, "dist", "climon-windows-x64.zip"),
    join(cDir, "climon-windows-x64.zip")
  );

  console.log(`→ Packaging C+1 (stub) zip at ${V2}...`);
  await $`bun ${resolve(projectRoot, "scripts/compile.ts")}`.env({
    ...process.env,
    CLIMON_VERSION: V2,
    CLIMON_UPDATE_PUBKEY_B64: kp.publicKeyRawB64,
  });
  const c1Dir = join(workRoot, "serve-c1");
  mkdirSync(c1Dir, { recursive: true });
  cpSync(
    resolve(projectRoot, "dist", "climon-windows-x64.zip"),
    join(c1Dir, "climon-windows-x64.zip")
  );

  // 3. Serve C first, signed for V.
  const { server: cServer, baseUrl: cBase } = await serveDir(cDir);
  await signReleaseDir({
    distDir: cDir,
    version: V,
    privateKeyPkcs8B64: kp.privateKeyPkcs8B64,
    baseUrl: cBase,
  });
  const cManifest = `${cBase}/manifest.json`;

  // ---- Scenario 1: bridge -> C migration ----
  console.log("\n=== Scenario 1: bridge -> C migration ===");
  const install = scratch("install");
  await unzipInto(bridgeZip, install);
  assertLegacyLayout(install);
  await $`${join(install, "climon.exe")} update`.env({
    ...process.env,
    CLIMON_TEST_MANIFEST_URL: cManifest,
  });
  assertStubLayout(install, V);
  const oldPreserved = existsSync(join(install, "climon.exe.old"));
  console.log(`  migrated to stub layout at ${V}; climon.exe.old preserved: ${oldPreserved}`);
  const ver1 = await $`${join(install, "climon.exe")} --version`.text();
  if (!ver1.includes(V)) throw new Error(`--version after migration = ${ver1}, want ${V}`);

  // ---- Scenario 2: C -> C+1 stub update (additive write + pointer flip, reaper) ----
  console.log("\n=== Scenario 2: C -> C+1 stub update ===");
  const { server: c1Server, baseUrl: c1Base } = await serveDir(c1Dir);
  await signReleaseDir({
    distDir: c1Dir,
    version: V2,
    privateKeyPkcs8B64: kp.privateKeyPkcs8B64,
    baseUrl: c1Base,
  });
  await $`${join(install, "climon.exe")} update`.env({
    ...process.env,
    CLIMON_TEST_MANIFEST_URL: `${c1Base}/manifest.json`,
  });
  assertStubLayout(install, V2);
  if (readdirSync(install).includes(`climon-${V}.dll`)) {
    throw new Error(`reaper failed: strictly-older climon-${V}.dll still present`);
  }
  console.log(`  updated to ${V2}; older payload reaped`);

  // ---- Scenario 3: idempotent install.exe --migrate ----
  console.log("\n=== Scenario 3: idempotent --migrate ===");
  const stagedC = scratch("staged-c");
  await unzipInto(join(cDir, "climon-windows-x64.zip"), stagedC);
  const migrateTarget = scratch("install-mig");
  await unzipInto(bridgeZip, migrateTarget);
  const installerExe = join(stagedC, "install.exe");
  await $`${installerExe} --migrate --dir ${migrateTarget} --source ${stagedC}`;
  assertStubLayout(migrateTarget, V);
  const before = readdirSync(migrateTarget).sort().join(",");
  await $`${installerExe} --migrate --dir ${migrateTarget} --source ${stagedC}`;
  assertStubLayout(migrateTarget, V);
  const after = readdirSync(migrateTarget).sort().join(",");
  if (before !== after) throw new Error(`--migrate not idempotent: ${before} != ${after}`);
  console.log("  --migrate is idempotent");

  // ---- Scenario 4: simulated brick + recovery (confirmed framing) ----
  console.log("\n=== Scenario 4: simulated brick + recovery ===");
  const broken = scratch("install-broken");
  mkdirSync(broken, { recursive: true });
  cpSync(installerExe, join(broken, "climon.exe"));
  cpSync(join(stagedC, "climon.dll"), join(broken, `climon-${V}.dll`));
  cpSync(join(stagedC, "climon-server.exe"), join(broken, "climon-server.exe"));
  await $`${installerExe} --migrate --dir ${broken} --source ${stagedC}`;
  assertStubLayout(broken, V);
  const ver4 = await $`${join(broken, "climon.exe")} --version`.text();
  if (!ver4.includes(V)) throw new Error(`--version after recovery = ${ver4}, want ${V}`);
  console.log("  recovered a bricked install to a clean stub layout");

  cServer.close();
  c1Server.close();
  console.log("\n✓ All upgrade-test scenarios passed.");
  console.log(`  (scratch dirs left under ${tmpdir()} for inspection; delete when done)`);
}

main().catch((err) => {
  console.error("\n✗ upgrade-test-harness failed:", err);
  process.exit(1);
});
