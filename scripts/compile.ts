#!/usr/bin/env bun
/**
 * Packages the shipped climon release artifacts.
 *
 * The shipped `climon` client is the **Rust** binary. On Unix it is the
 * executable built from `rust/climon-cli` (binary `climon`); on Windows it is
 * the cdylib built from `rust/climon-dll` (`climon.dll`), loaded in-process by a
 * tiny versioned stub so self-updates never block on a running `climon.exe`. The
 * dashboard **server** is still the Bun binary compiled from `src/server.ts`
 * (`climon-server`). Installation is performed by a dedicated installer built
 * from `rust/climon-setup` and shipped as `install[.exe]`; on Windows it embeds
 * the two tiny stubs (`climon.exe`/`climon-server.exe`) and places them itself,
 * so the stubs are NOT separate zip entries.
 *
 * Output: dist/climon-<platform>.zip, each containing `install[.exe]` (dedicated
 * installer), the client (`climon` on Unix / `climon.dll` on Windows), and
 * `climon-server[.exe]` (Bun). dist/ contains only zips.
 *
 * Two modes:
 *   - **local / default**: build ONLY the host target's Rust client + installer
 *     with cargo and emit just dist/climon-<host>.zip (so a developer can build +
 *     run on one machine).
 *   - **assemble** (CLIMON_ASSEMBLE=1): package all five zips from prebuilt Rust
 *     binaries staged under dist/.rust-clients/<platform>/ (the client and
 *     `install[.exe]`); used by the release CI matrix, which cross-compiles each
 *     target on its native runner.
 */
import { $ } from "bun";
import {
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { zipSync, unzipSync, type ZipOptions } from "fflate";

const projectRoot = dirname(dirname(import.meta.path));
const rustDir = resolve(projectRoot, "rust");
const distDir = resolve(projectRoot, "dist");
const stageRoot = resolve(distDir, ".stage");
const rustClientsStageDir = resolve(distDir, ".rust-clients");
const serverEntrypoint = resolve(projectRoot, "src/server.ts");
const embeddedAssetsPath = resolve(projectRoot, "src/server/embedded-assets.ts");

const assembleMode = process.env.CLIMON_ASSEMBLE === "1";
// Host-only, test-only: emit the pinned legacy layout required by the upgrade
// harness. Never set by the release pipeline. Ignored in assemble mode.
const legacyLayoutMode = process.env.CLIMON_LEGACY_LAYOUT === "1" && !assembleMode;
const testUpdateEndpoint = process.env.CLIMON_TEST_UPDATE_ENDPOINT === "1";
const testEndpointArgs = testUpdateEndpoint
  ? ["--features", "test-update-endpoint"]
  : [];

/**
 * `bun build` flags that activate the embedded-asset code path in
 * `src/server/assets.ts` (the `__CLIMON_EMBEDDED__` define). EVERY build that
 * ships a self-contained server — the compiled `climon-server` binary — must
 * pass these, otherwise the server falls back to an on-the-fly source build that
 * does not exist on an end user's machine and the dashboard assets 404. Exported
 * so the server smoke test compiles the binary the same way and can never
 * silently desync from the real pipeline.
 */
export const EMBEDDED_DEFINE_ARGS: string[] = ["--define", "__CLIMON_EMBEDDED__=true"];

/**
 * `bun build` flags that bake the Application Insights connection string into the
 * compiled `climon-server` binary via the `__CLIMON_TELEMETRY_CONNECTION__` define
 * (consumed by `src/telemetry/connection.ts`). The string is read from the build
 * environment — the release workflow supplies it from the
 * `APPLICATIONINSIGHTS_CONNECTION_STRING` GitHub Actions secret — so it never lives
 * in source. Absent (local builds, forks without the secret) it returns no args and
 * the embedded constant stays `""`, so no telemetry endpoint is shipped. Telemetry
 * still only flows when an operator opts in via `telemetry.enabled`.
 */
export function telemetryDefineArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const conn = env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim();
  if (!conn) return [];
  return ["--define", `__CLIMON_TELEMETRY_CONNECTION__=${JSON.stringify(conn)}`];
}

type BuildTarget = {
  platform: string;
  /** Bun cross-compile target used for the climon-server binary. */
  target: string;
};

type ZipEntry = {
  name: string;
  path?: string;
  data?: Uint8Array;
};

/**
 * The bare zip entry names for a platform.
 *
 * Default (stub model): `install[.exe]` + client (`climon.dll` on Windows / `climon`
 * on Unix) + `climon-server[.exe]`.
 *
 * `legacy: true` returns the pinned legacy layout used ONLY by the upgrade-test
 * harness: the full standalone client (`climon[.exe]`) + `climon-server[.exe]`, with no
 * installer and no DLL. The absence of `install.exe`+`climon.dll` is what marks a release
 * as non-stub-model to `should_migrate_legacy`.
 */
export function zipEntryNamesForPlatform(
  platform: string,
  opts: { legacy?: boolean } = {}
): string[] {
  const isWindows = platform.startsWith("windows");
  const exe = isWindows ? ".exe" : "";
  if (opts.legacy) {
    return [`climon${exe}`, `climon-server${exe}`];
  }
  const client = isWindows ? "climon.dll" : "climon";
  return [`install${exe}`, client, `climon-server${exe}`];
}

const allTargets: BuildTarget[] = [
  { platform: "linux-x64", target: "bun-linux-x64" },
  { platform: "linux-arm64", target: "bun-linux-arm64" },
  { platform: "darwin-x64", target: "bun-darwin-x64" },
  { platform: "darwin-arm64", target: "bun-darwin-arm64" },
  { platform: "windows-x64", target: "bun-windows-x64" },
];

/** The host platform name (e.g. "darwin-arm64"), matching the zip naming. */
export function hostPlatform(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const os =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
      ? "darwin"
      : "linux";
  return `${os}-${arch}`;
}

// Map bun target names to their GitHub release archive names.
// Bun's cross-compile download fails on Windows when the project is not on the
// C: drive (https://github.com/oven-sh/bun/issues/25346). We work around this
// by pre-downloading the base executables and passing --compile-executable-path.
const targetToReleaseName: Record<string, string> = {
  "bun-linux-x64": "bun-linux-x64",
  "bun-linux-arm64": "bun-linux-aarch64",
  "bun-darwin-x64": "bun-darwin-x64",
  "bun-darwin-arm64": "bun-darwin-aarch64",
};

const bunVersion = Bun.version; // e.g. "1.3.14"
const crossBinCache = resolve(tmpdir(), "climon-cross-compile-cache", bunVersion);

/**
 * Ensures a cross-compile base executable is available locally for the given
 * target. Returns the path to the extracted bun binary, or undefined if the
 * target is the native platform (no workaround needed).
 */
async function ensureCrossBinary(target: string): Promise<string | undefined> {
  const releaseName = targetToReleaseName[target];
  if (!releaseName) return undefined; // native target (e.g. bun-windows-x64)

  const binPath = resolve(crossBinCache, releaseName, "bun");
  if (existsSync(binPath)) return binPath;

  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${releaseName}.zip`;
  console.log(`  ↓ Downloading ${releaseName} base executable...`);
  mkdirSync(crossBinCache, { recursive: true });

  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`Failed to download ${url}: ${resp.status}`);
  const zipData = new Uint8Array(await resp.arrayBuffer());

  // Extract using fflate
  const extracted = unzipSync(zipData);
  for (const [name, data] of Object.entries(extracted)) {
    if (data.length === 0) continue; // skip directories
    const outPath = resolve(crossBinCache, name);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, data);
  }

  if (!existsSync(binPath)) {
    throw new Error(
      `Expected extracted binary at ${binPath} but it was not found`
    );
  }

  return binPath;
}

/**
 * Reads the prebuilt Rust client binary staged for a platform at
 * dist/.rust-clients/<platform>/ — `climon.dll` on Windows, `climon` on Unix.
 * Used in assemble mode; the bytes are read up front, before dist/ is cleaned,
 * so the clean does not delete them.
 */
function readStagedRustClient(platform: string): Uint8Array {
  const isWindows = platform.startsWith("windows");
  const clientName = isWindows ? "climon.dll" : "climon";
  const staged = resolve(rustClientsStageDir, platform, clientName);
  if (!existsSync(staged)) {
    throw new Error(
      `Assemble mode: missing prebuilt Rust client for ${platform} at ${staged}`
    );
  }
  return new Uint8Array(readFileSync(staged));
}

/**
 * Reads the prebuilt dedicated installer (`install[.exe]`) staged for a platform
 * at dist/.rust-clients/<platform>/. On Windows the installer embeds the two
 * stubs, so they are not staged separately. Used in assemble mode.
 */
function readStagedInstaller(platform: string): Uint8Array {
  const isWindows = platform.startsWith("windows");
  const exe = isWindows ? ".exe" : "";
  const staged = resolve(rustClientsStageDir, platform, `install${exe}`);
  if (!existsSync(staged)) {
    throw new Error(
      `Assemble mode: missing prebuilt installer for ${platform} at ${staged}`
    );
  }
  return new Uint8Array(readFileSync(staged));
}

/** Builds the host Rust client with cargo and returns its bytes (local mode). */
async function buildHostRustClient(platform: string): Promise<Uint8Array> {
  const isWindows = platform.startsWith("windows");
  // The legacy layout ships the full standalone client on every platform,
  // including Windows (it carries the migration-aware updater via climon_cli::run).
  if (legacyLayoutMode) {
    console.log(`→ Building standalone Rust client (cargo, ${platform}, legacy layout)...`);
    await $`cargo build --release -p climon-cli ${testEndpointArgs}`.cwd(rustDir);
    const builtName = isWindows ? "climon.exe" : "climon";
    const built = resolve(rustDir, "target", "release", builtName);
    if (!existsSync(built)) {
      throw new Error(`Expected cargo to produce ${built} but it was not found`);
    }
    return new Uint8Array(readFileSync(built));
  }
  console.log(`→ Building Rust client (cargo, ${platform})...`);
  if (isWindows) {
    await $`cargo build --release -p climon-dll ${testEndpointArgs}`.cwd(rustDir);
    const built = resolve(rustDir, "target", "release", "climon.dll");
    if (!existsSync(built)) {
      throw new Error(`Expected cargo to produce ${built} but it was not found`);
    }
    return new Uint8Array(readFileSync(built));
  }
  await $`cargo build --release -p climon-cli ${testEndpointArgs}`.cwd(rustDir);
  const built = resolve(rustDir, "target", "release", "climon");
  if (!existsSync(built)) {
    throw new Error(`Expected cargo to produce ${built} but it was not found`);
  }
  return new Uint8Array(readFileSync(built));
}

/**
 * Builds the host dedicated installer with cargo and returns its bytes (local
 * mode). On Windows the two stubs are built first and their paths passed via
 * CLIMON_CLIENT_STUB/CLIMON_SERVER_STUB so `climon-setup`'s build.rs embeds them.
 */
async function buildHostInstaller(platform: string): Promise<Uint8Array> {
  const isWindows = platform.startsWith("windows");
  const exe = isWindows ? ".exe" : "";
  console.log(`→ Building Rust installer (cargo, ${platform})...`);
  let stubEnv: Record<string, string> = {};
  if (isWindows) {
    await $`cargo build --release -p climon-stub`.cwd(rustDir);
    stubEnv = {
      // Signals climon-setup/build.rs that this is a real installer build, so a
      // missing stub is a hard error instead of an empty placeholder.
      CLIMON_BUILDING_INSTALLER: "1",
      CLIMON_CLIENT_STUB: resolve(rustDir, "target", "release", "climon-stub.exe"),
      CLIMON_SERVER_STUB: resolve(
        rustDir,
        "target",
        "release",
        "climon-server-stub.exe"
      ),
    };
  }
  await $`cargo build --release -p climon-setup ${testEndpointArgs}`
    .env({ ...process.env, ...stubEnv })
    .cwd(rustDir);
  const built = resolve(rustDir, "target", "release", `install${exe}`);
  if (!existsSync(built)) {
    throw new Error(`Expected cargo to produce ${built} but it was not found`);
  }
  return new Uint8Array(readFileSync(built));
}

async function main() {
  // Determine which platforms to package, and load each one's Rust client
  // binary BEFORE cleaning dist/ (assemble mode stages them under dist/).
  const targets = assembleMode
    ? allTargets
    : allTargets.filter((t) => t.platform === hostPlatform());

  if (targets.length === 0) {
    throw new Error(`No build target matches host platform ${hostPlatform()}`);
  }

  const rustClients = new Map<string, Uint8Array>();
  const rustInstallers = new Map<string, Uint8Array>();
  if (assembleMode) {
    console.log("→ Assemble mode: loading prebuilt Rust clients + installers...");
    for (const { platform } of targets) {
      rustClients.set(platform, readStagedRustClient(platform));
      rustInstallers.set(platform, readStagedInstaller(platform));
    }
  } else {
    const platform = targets[0].platform;
    rustClients.set(platform, await buildHostRustClient(platform));
    if (!legacyLayoutMode) {
      rustInstallers.set(platform, await buildHostInstaller(platform));
    }
  }

  // Step 1: Embed assets so the server binary serves the dashboard bundle.
  console.log("→ Embedding xterm assets...");
  await $`bun ${resolve(projectRoot, "scripts/embed-assets.ts")}`;

  // Step 2: Start from a clean dist/ so it ends up containing only zips.
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  try {
    mkdirSync(stageRoot, { recursive: true });

    for (const { platform, target } of targets) {
      const isWindows = platform.startsWith("windows");
      const exe = isWindows ? ".exe" : "";
      const stageDir = resolve(stageRoot, platform);
      mkdirSync(stageDir, { recursive: true });

      const clientData = rustClients.get(platform);
      if (!clientData) throw new Error(`Missing Rust client for ${platform}`);
      const installerData = rustInstallers.get(platform);
      if (!legacyLayoutMode && !installerData) {
        throw new Error(`Missing installer for ${platform}`);
      }

      const serverOut = resolve(stageDir, `climon-server${exe}`);
      console.log(`→ Compiling climon-server (${target})...`);
      const crossBin = await ensureCrossBinary(target);
      const execPathArgs = crossBin
        ? ["--compile-executable-path", crossBin]
        : [];
      await $`bun build ${serverEntrypoint} --compile --target ${target} ${EMBEDDED_DEFINE_ARGS} ${telemetryDefineArgs()} ${execPathArgs} --outfile ${serverOut}`;

      // Read the produced binaries back and zip them under bare names. On Unix,
      // set os=3 + 0o755 perms so extracted binaries keep their executable bit.
      const fileOpts: ZipOptions = isWindows
        ? { level: 6 }
        : { level: 6, os: 3, attrs: 0o755 << 16 };

      const zipFiles: ZipEntry[] = legacyLayoutMode
        ? [
            { name: `climon${exe}`, data: clientData },
            { name: `climon-server${exe}`, path: serverOut },
          ]
        : [
            { name: `install${exe}`, data: installerData },
            { name: isWindows ? "climon.dll" : "climon", data: clientData },
            { name: `climon-server${exe}`, path: serverOut },
          ];

      const zipEntries: Record<string, [Uint8Array, ZipOptions]> = {};

      for (const { name, path, data } of zipFiles) {
        const bytes = data ?? new Uint8Array(readFileSync(path!));
        zipEntries[name] = [bytes, fileOpts];
      }

      const zipped = zipSync(zipEntries);

      const zipPath = resolve(distDir, `climon-${platform}.zip`);
      writeFileSync(zipPath, zipped);
      console.log(`  ✓ ${zipPath}`);
    }
  } finally {
    // Remove the per-platform staging dirs and the generated embedded bundle so a
    // later source-mode `climon server` never picks the bundle up off disk.
    rmSync(stageRoot, { recursive: true, force: true });
    rmSync(rustClientsStageDir, { recursive: true, force: true });
    rmSync(embeddedAssetsPath, { force: true });
  }

  console.log(
    `\n✓ ${assembleMode ? "All platform zips" : `Host zip (${hostPlatform()})`} written to ${distDir}/`
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
