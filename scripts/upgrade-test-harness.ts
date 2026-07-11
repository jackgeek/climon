#!/usr/bin/env bun
/**
 * Cross-platform end-to-end migration harness.
 *
 * It builds the actual released v3.1.3 updater from a detached temporary
 * worktree, applying only local endpoint/key substitutions in that checkout.
 * The released updater performs the first install[.exe] -> climon[.exe] hop;
 * the current installer bytes then bootstrap into the current platform layout.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { zipEntryNamesForPlatform } from "./compile.js";
import { signReleaseDir } from "./sign-release.js";
import {
  LEGACY_UPDATER_COMMIT,
  LEGACY_VERSION,
  assertCurrentLayout,
  assertInstallSnapshot,
  assertLegacyLayout,
  assertReleasedLegacyUpdaterMapping,
  closeServer,
  currentLayoutKind,
  generateTestKeypair,
  hostHarnessPlatform,
  replaceExactlyOnce,
  serveDir,
  snapshotInstallDir,
  type HarnessPlatform,
  type TestKeypair,
} from "./upgrade-harness/pack.js";

const projectRoot = dirname(import.meta.dir);
const C_VERSION = "9.9.0";
const C1_VERSION = "9.9.1";
const CANONICAL_MANIFEST_URL =
  "https://github.com/jackgeek/climon/releases/latest/download/manifest.json";
const KEEP_SCRATCH = process.env.CLIMON_KEEP_UPGRADE_SCRATCH === "1";

type ServedDir = Awaited<ReturnType<typeof serveDir>>;
type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hostArchivePlatform(): string {
  const platform = hostHarnessPlatform();
  const os = platform === "win32" ? "windows" : platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}

function executableNames(platform: HarnessPlatform) {
  const exe = platform === "win32" ? ".exe" : "";
  return {
    client: `climon${exe}`,
    server: `climon-server${exe}`,
    installer: `install${exe}`,
  };
}

function commandEnv(
  workRoot: string,
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const temp = join(workRoot, "temp");
  const climonHome = join(workRoot, "climon-home");
  for (const dir of [temp, climonHome]) {
    mkdirSync(dir, { recursive: true });
  }
  return {
    ...process.env,
    CLIMON_HOME: climonHome,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    ...overrides,
  };
}

function runtimeEnv(
  workRoot: string,
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const home = join(workRoot, "home");
  const localAppData = join(home, "AppData", "Local");
  mkdirSync(localAppData, { recursive: true });
  return commandEnv(workRoot, {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: localAppData,
    XDG_CACHE_HOME: join(home, ".cache"),
    ...overrides,
  });
}

function legacyBuildEnv(workRoot: string): NodeJS.ProcessEnv {
  const env = commandEnv(workRoot);
  delete env.CLIMON_TEST_UPDATE_ENDPOINT;
  delete env.CLIMON_TEST_MANIFEST_URL;
  delete env.CLIMON_UPDATE_PUBKEY_B64;
  delete env.CLIMON_VERSION;
  delete env.CARGO_TARGET_DIR;
  return env;
}

async function runInherited(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const child = Bun.spawn(argv, {
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${argv.join(" ")} exited with code ${exitCode}`);
  }
}

async function runCaptured(
  program: string,
  args: string[],
  workRoot: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<CommandResult> {
  const child = Bun.spawn([program, ...args], {
    cwd: dirname(program),
    env: runtimeEnv(workRoot, extraEnv),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const [exitCode, stdoutText, stderrText] = await Promise.all([
    child.exited,
    stdout,
    stderr,
  ]);
  return { exitCode, stdout: stdoutText, stderr: stderrText };
}

function requireSuccess(result: CommandResult, label: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} exited with ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
}

function requireOutput(result: CommandResult, expected: string, label: string): void {
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes(expected)) {
    throw new Error(`${label} output did not contain ${JSON.stringify(expected)}:\n${output}`);
  }
}

function archiveFiles(zipPath: string): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(readFileSync(zipPath)));
}

function assertArchiveEntries(zipPath: string, expected: string[]): void {
  const actual = Object.keys(archiveFiles(zipPath)).sort();
  const wanted = [...expected].sort();
  if (actual.join("\n") !== wanted.join("\n")) {
    throw new Error(
      `${zipPath} entries were ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`
    );
  }
}

function archiveEntry(zipPath: string, name: string): Buffer {
  const bytes = archiveFiles(zipPath)[name];
  if (!bytes) throw new Error(`archive ${zipPath} is missing ${name}`);
  return Buffer.from(bytes);
}

function writeExecutable(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes);
  if (process.platform !== "win32") chmodSync(path, 0o755);
}

function installLegacyFixture(
  legacyZip: string,
  installDir: string,
  platform: HarnessPlatform
): void {
  const names = executableNames(platform);
  rmSync(installDir, { recursive: true, force: true });
  mkdirSync(installDir, { recursive: true });
  writeExecutable(
    join(installDir, names.client),
    archiveEntry(legacyZip, names.installer)
  );
  writeExecutable(
    join(installDir, names.server),
    archiveEntry(legacyZip, names.server)
  );
  assertLegacyLayout(installDir, platform);
}

function cloneInstall(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
}

function tamperedZip(bytes: Buffer): Buffer {
  return Buffer.concat([bytes, Buffer.from("\nclimon-harness-tamper\n")]);
}

function requestCount(served: ServedDir, name: string): number {
  return served.requests.filter((request) => request === name).length;
}

async function waitForCondition(
  label: string,
  condition: () => boolean,
  timeoutMs = 120_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (condition()) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `${label} did not become true within ${timeoutMs}ms${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`
  );
}

function patchLegacySource(
  legacySource: string,
  manifestUrl: string,
  keypair: TestKeypair
): void {
  const mappingPath = join(
    legacySource,
    "rust",
    "climon-update",
    "src",
    "install_manifest.rs"
  );
  assertReleasedLegacyUpdaterMapping(readFileSync(mappingPath, "utf8"));

  const checkPath = join(
    legacySource,
    "rust",
    "climon-update",
    "src",
    "check.rs"
  );
  const checkSource = readFileSync(checkPath, "utf8");
  writeFileSync(
    checkPath,
    replaceExactlyOnce(
      checkSource,
      CANONICAL_MANIFEST_URL,
      manifestUrl,
      "canonical manifest URL"
    )
  );

  const pubkeyPath = join(legacySource, "src", "update", "pubkey.ts");
  const pubkeySource = readFileSync(pubkeyPath, "utf8");
  const match = pubkeySource.match(
    /(export const UPDATE_PUBLIC_KEY_B64\s*=\s*")([^"]+)(";?)/
  );
  requireCondition(match, "released v3.1.3 public key literal shape is absent");
  requireCondition(
    Buffer.from(match[2], "base64").length === 32,
    "released v3.1.3 public key is not a raw Ed25519 key"
  );
  writeFileSync(
    pubkeyPath,
    replaceExactlyOnce(
      pubkeySource,
      match[0],
      `${match[1]}${keypair.publicKeyRawB64}${match[3]}`,
      "UPDATE_PUBLIC_KEY_B64 literal"
    )
  );

  const packagePath = join(legacySource, "package.json");
  const packageSource = readFileSync(packagePath, "utf8");
  const packageJson = JSON.parse(packageSource) as { version?: string };
  if (packageJson.version !== LEGACY_VERSION) {
    requireCondition(packageJson.version, "released package.json has no version");
    writeFileSync(
      packagePath,
      replaceExactlyOnce(
        packageSource,
        `"version": "${packageJson.version}"`,
        `"version": "${LEGACY_VERSION}"`,
        "package version"
      )
    );
  }
  const patchedPackage = JSON.parse(readFileSync(packagePath, "utf8")) as {
    version?: string;
  };
  requireCondition(
    patchedPackage.version === LEGACY_VERSION,
    `legacy fixture version is ${patchedPackage.version}, expected ${LEGACY_VERSION}`
  );
}

async function buildLegacyFixture(
  legacySource: string,
  outputZip: string,
  manifestUrl: string,
  keypair: TestKeypair,
  workRoot: string
): Promise<void> {
  await runInherited(
    ["git", "worktree", "add", "--detach", legacySource, LEGACY_UPDATER_COMMIT],
    projectRoot,
    legacyBuildEnv(workRoot)
  );
  patchLegacySource(legacySource, manifestUrl, keypair);

  console.log("→ Building released v3.1.3 legacy updater...");
  await runInherited(
    ["bun", "install", "--frozen-lockfile"],
    legacySource,
    legacyBuildEnv(workRoot)
  );
  await runInherited(
    ["bun", "scripts/compile.ts"],
    legacySource,
    legacyBuildEnv(workRoot)
  );

  const platform = hostArchivePlatform();
  const builtZip = join(legacySource, "dist", `climon-${platform}.zip`);
  const names = executableNames(hostHarnessPlatform());
  assertArchiveEntries(builtZip, [
    names.installer,
    names.server,
    "climon-alpha",
  ]);
  cpSync(builtZip, outputZip);
}

async function buildCurrentRelease(
  version: string,
  outputDir: string,
  keypair: TestKeypair,
  workRoot: string
): Promise<string> {
  console.log(`→ Building current release ${version}...`);
  await runInherited(
    ["bun", resolve(projectRoot, "scripts", "compile.ts")],
    projectRoot,
    commandEnv(workRoot, {
      CARGO_TARGET_DIR: join(workRoot, "cargo-current"),
      CLIMON_TEST_UPDATE_ENDPOINT: "1",
      CLIMON_VERSION: version,
      CLIMON_UPDATE_PUBKEY_B64: keypair.publicKeyRawB64,
    })
  );

  mkdirSync(outputDir, { recursive: true });
  const platform = hostArchivePlatform();
  const zipName = `climon-${platform}.zip`;
  const builtZip = join(projectRoot, "dist", zipName);
  const outputZip = join(outputDir, zipName);
  assertArchiveEntries(builtZip, zipEntryNamesForPlatform(platform));
  cpSync(builtZip, outputZip);
  return outputZip;
}

async function assertVersion(
  client: string,
  version: string,
  workRoot: string
): Promise<CommandResult> {
  const result = await runCaptured(client, ["--version"], workRoot);
  requireSuccess(result, `${client} --version`);
  requireOutput(result, version, `${client} --version`);
  return result;
}

async function removeLegacyWorktree(
  legacySource: string,
  workRoot: string
): Promise<void> {
  if (!existsSync(legacySource)) return;
  await runInherited(
    ["git", "worktree", "remove", "--force", legacySource],
    projectRoot,
    commandEnv(workRoot)
  );
  await runInherited(
    ["git", "worktree", "prune"],
    projectRoot,
    commandEnv(workRoot)
  );
}

async function closeOwnedServer(server: Server | undefined): Promise<void> {
  if (server?.listening) await closeServer(server);
}

async function main(): Promise<void> {
  const scratchBase = join(projectRoot, ".test-tmp");
  mkdirSync(scratchBase, { recursive: true });
  const workRoot = mkdtempSync(join(scratchBase, "upgrade-harness-"));
  const legacySource = join(workRoot, "legacy-source");
  const savedDist = join(workRoot, "saved-dist");
  const projectDist = join(projectRoot, "dist");
  const hadDist = existsSync(projectDist);
  if (hadDist) cpSync(projectDist, savedDist, { recursive: true });

  let c: ServedDir | undefined;
  let c1: ServedDir | undefined;
  let failure: unknown;
  const cleanupErrors: string[] = [];

  try {
    const keypair = await generateTestKeypair();
    const platform = hostHarnessPlatform();
    const names = executableNames(platform);
    const archivePlatform = hostArchivePlatform();
    const cDir = join(workRoot, "release-c");
    const c1Dir = join(workRoot, "release-c1");
    mkdirSync(cDir, { recursive: true });
    mkdirSync(c1Dir, { recursive: true });

    c = await serveDir(cDir);
    const cManifestUrl = `${c.baseUrl}/manifest.json`;
    const legacyZip = join(workRoot, `legacy-v${LEGACY_VERSION}.zip`);
    await buildLegacyFixture(
      legacySource,
      legacyZip,
      cManifestUrl,
      keypair,
      workRoot
    );

    const cZip = await buildCurrentRelease(C_VERSION, cDir, keypair, workRoot);
    await signReleaseDir({
      distDir: cDir,
      version: C_VERSION,
      privateKeyPkcs8B64: keypair.privateKeyPkcs8B64,
      baseUrl: c.baseUrl,
    });
    const c1Zip = await buildCurrentRelease(C1_VERSION, c1Dir, keypair, workRoot);
    c1 = await serveDir(c1Dir);
    await signReleaseDir({
      distDir: c1Dir,
      version: C1_VERSION,
      privateKeyPkcs8B64: keypair.privateKeyPkcs8B64,
      baseUrl: c1.baseUrl,
    });

    const cZipName = `climon-${archivePlatform}.zip`;
    const validCBytes = readFileSync(cZip);
    const mainInstall = join(workRoot, "install-main");
    installLegacyFixture(legacyZip, mainInstall, platform);
    const mainClient = join(mainInstall, names.client);
    await assertVersion(mainClient, LEGACY_VERSION, workRoot);

    console.log("\n=== 1. First-hop tamper rejection ===");
    const firstHopStart = snapshotInstallDir(mainInstall);
    const firstHopDownloads = requestCount(c, cZipName);
    writeFileSync(cZip, tamperedZip(validCBytes));
    const firstHopTamper = await runCaptured(mainClient, ["update"], workRoot);
    requireCondition(
      firstHopTamper.exitCode !== 0,
      "legacy updater accepted a tampered first-hop artifact"
    );
    requireOutput(firstHopTamper, "signature verification failed", "first-hop tamper");
    assertInstallSnapshot(mainInstall, firstHopStart);
    requireCondition(
      requestCount(c, cZipName) === firstHopDownloads + 1,
      "legacy first-hop tamper did not perform exactly one artifact download"
    );

    console.log("\n=== 2. Released legacy updater copies installer over climon ===");
    writeFileSync(cZip, validCBytes);
    const validFirstHopDownloads = requestCount(c, cZipName);
    const firstHop = await runCaptured(mainClient, ["update"], workRoot);
    requireSuccess(firstHop, "released v3.1.3 update");
    assertLegacyLayout(mainInstall, platform);
    requireCondition(
      readFileSync(mainClient).equals(archiveEntry(cZip, names.installer)),
      `released updater did not copy ${names.installer} over ${names.client}`
    );
    requireCondition(
      requestCount(c, cZipName) === validFirstHopDownloads + 1,
      "valid legacy first hop did not perform exactly one artifact download"
    );
    if (currentLayoutKind(platform) === "windows-stub") {
      requireCondition(
        existsSync(join(mainInstall, "climon.exe.old")),
        "Windows legacy first hop did not retain climon.exe.old"
      );
    }

    const offlineInstalls =
      platform === "win32"
        ? [
            join(workRoot, "offline-normal"),
            join(workRoot, "offline-update"),
            join(workRoot, "offline-missing-old"),
          ]
        : [join(workRoot, "offline-unix")];
    for (const install of offlineInstalls) cloneInstall(mainInstall, install);

    console.log("\n=== 3. Bootstrap tamper rejection ===");
    const bootstrapStart = snapshotInstallDir(mainInstall);
    const bootstrapDownloads = requestCount(c, cZipName);
    writeFileSync(cZip, tamperedZip(validCBytes));
    const bootstrapTamper = await runCaptured(mainClient, ["update"], workRoot, {
      CLIMON_TEST_MANIFEST_URL: cManifestUrl,
    });
    requireCondition(
      bootstrapTamper.exitCode !== 0,
      "renamed bootstrap accepted a tampered canonical redownload"
    );
    assertInstallSnapshot(mainInstall, bootstrapStart);
    requireCondition(
      requestCount(c, cZipName) === bootstrapDownloads + 1,
      "bootstrap tamper did not perform its own artifact download"
    );

    console.log("\n=== 4. Bootstrap success and current layout recovery ===");
    writeFileSync(cZip, validCBytes);
    const recoveryDownloads = requestCount(c, cZipName);
    const windowsFallback = join(mainInstall, "climon.exe.old");
    const fallbackBytes =
      platform === "win32" ? readFileSync(windowsFallback) : undefined;
    const bootstrapSuccess = await runCaptured(mainClient, ["--version"], workRoot, {
      CLIMON_TEST_MANIFEST_URL: cManifestUrl,
    });
    requireSuccess(bootstrapSuccess, "valid bootstrap");
    requireCondition(
      requestCount(c, cZipName) === recoveryDownloads + 1,
      "successful bootstrap did not perform its own artifact download"
    );

    if (currentLayoutKind(platform) === "unix") {
      requireOutput(bootstrapSuccess, C_VERSION, "Unix automatic bootstrap resume");
      assertCurrentLayout(mainInstall, C_VERSION, platform);
    } else {
      await waitForCondition("Windows recovered layout", () => {
        assertCurrentLayout(mainInstall, C_VERSION, platform);
        return true;
      });
      requireCondition(
        existsSync(windowsFallback),
        "Windows recovery removed climon.exe.old"
      );
      requireCondition(
        readFileSync(windowsFallback).equals(fallbackBytes!),
        "Windows recovery changed climon.exe.old"
      );
    }
    await assertVersion(mainClient, C_VERSION, workRoot);

    console.log("\n=== 5. Current C to C+1 update ===");
    const currentUpdate = await runCaptured(mainClient, ["update"], workRoot, {
      CLIMON_TEST_MANIFEST_URL: `${c1.baseUrl}/manifest.json`,
    });
    requireSuccess(currentUpdate, "current C to C+1 update");
    assertCurrentLayout(mainInstall, C1_VERSION, platform);
    await assertVersion(mainClient, C1_VERSION, workRoot);
    if (currentLayoutKind(platform) === "unix") {
      requireCondition(
        readFileSync(mainClient).equals(archiveEntry(c1Zip, "climon")),
        "Unix current update did not install the archive client payload"
      );
    } else {
      requireCondition(
        readFileSync(join(mainInstall, `climon-${C1_VERSION}.dll`)).equals(
          archiveEntry(c1Zip, "climon.dll")
        ),
        "Windows current update did not install the versioned DLL payload"
      );
    }

    console.log("\n=== 6. Offline bootstrap recovery ===");
    await closeServer(c.server);
    c = undefined;
    if (platform !== "win32") {
      const offlineInstall = offlineInstalls[0];
      const offlineClient = join(offlineInstall, names.client);
      const before = snapshotInstallDir(offlineInstall);
      const offline = await runCaptured(offlineClient, ["--version"], workRoot, {
        CLIMON_TEST_MANIFEST_URL: cManifestUrl,
      });
      requireCondition(offline.exitCode !== 0, "offline Unix bootstrap succeeded");
      requireOutput(offline, "requires a network connection", "offline Unix bootstrap");
      requireOutput(offline, "install.sh", "offline Unix bootstrap");
      assertInstallSnapshot(offlineInstall, before);
    } else {
      const [normalInstall, updateInstall, missingOldInstall] = offlineInstalls;

      const normalClient = join(normalInstall, names.client);
      const normalBefore = snapshotInstallDir(normalInstall);
      const normal = await runCaptured(normalClient, ["--version"], workRoot, {
        CLIMON_TEST_MANIFEST_URL: cManifestUrl,
      });
      requireSuccess(normal, "offline Windows fallback");
      requireOutput(normal, LEGACY_VERSION, "offline Windows fallback");
      assertInstallSnapshot(normalInstall, normalBefore);

      const updateClient = join(updateInstall, names.client);
      const updateBefore = snapshotInstallDir(updateInstall);
      const update = await runCaptured(updateClient, ["update"], workRoot, {
        CLIMON_TEST_MANIFEST_URL: cManifestUrl,
      });
      requireCondition(update.exitCode !== 0, "offline Windows update recursed");
      requireOutput(update, "Please retry climon update.", "offline Windows update");
      assertInstallSnapshot(updateInstall, updateBefore);

      const missingOldClient = join(missingOldInstall, names.client);
      rmSync(join(missingOldInstall, "climon.exe.old"), { force: true });
      const missingBefore = snapshotInstallDir(missingOldInstall);
      const missing = await runCaptured(missingOldClient, ["--version"], workRoot, {
        CLIMON_TEST_MANIFEST_URL: cManifestUrl,
      });
      requireCondition(
        missing.exitCode !== 0,
        "offline Windows bootstrap succeeded without .old"
      );
      requireOutput(missing, "install.ps1", "missing Windows fallback");
      assertInstallSnapshot(missingOldInstall, missingBefore);
    }

    console.log("\n✓ All cross-platform legacy update migration scenarios passed.");
  } catch (error) {
    failure = error;
  }

  for (const served of [c, c1]) {
    try {
      await closeOwnedServer(served?.server);
    } catch (error) {
      cleanupErrors.push(`close server: ${String(error)}`);
    }
  }
  try {
    await removeLegacyWorktree(legacySource, workRoot);
  } catch (error) {
    cleanupErrors.push(`remove legacy worktree: ${String(error)}`);
  }
  try {
    rmSync(projectDist, { recursive: true, force: true });
    if (hadDist) renameSync(savedDist, projectDist);
  } catch (error) {
    cleanupErrors.push(`restore dist: ${String(error)}`);
  }

  if (failure || cleanupErrors.length > 0) {
    if (KEEP_SCRATCH) {
      console.error(`upgrade harness scratch preserved: ${workRoot}`);
    } else if (cleanupErrors.length === 0) {
      rmSync(workRoot, { recursive: true, force: true });
    }
    const cleanup = cleanupErrors.length
      ? `\ncleanup errors:\n${cleanupErrors.join("\n")}`
      : "";
    const failureMessage = failure
      ? failure instanceof Error
        ? failure.message
        : String(failure)
      : "upgrade harness cleanup failed";
    const message = `${failureMessage}${cleanup}`;
    throw new Error(KEEP_SCRATCH ? message : message.replaceAll(workRoot, "<scratch>"));
  }

  if (KEEP_SCRATCH) {
    console.log(`scratch preserved by request: ${workRoot}`);
  } else {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("\n✗ upgrade-test-harness failed:", error);
  process.exitCode = 1;
});
