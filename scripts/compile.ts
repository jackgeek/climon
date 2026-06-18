#!/usr/bin/env bun
/**
 * Packages the shipped climon release artifacts.
 *
 * The shipped `climon` client is the **Rust** binary built from
 * `rust/climon-cli` (binary `climon` / `climon.exe`). It is packaged in each zip
 * under the name `install`. The dashboard **server** is still the Bun binary
 * compiled from `src/server.ts` (`climon-server`), and the in-process server JS
 * bundle (`climon-beta`) is still produced from `src/server-bundle-entry.ts`.
 * The former JS installer bundle is replaced by a tiny `climon-alpha` **sentinel
 * marker**: its mere presence next to the executable triggers the native Rust
 * self-install (see `climon-cli`'s `try_run_installer`).
 *
 * Output: dist/climon-<platform>.zip, each containing `install` (Rust client),
 * `climon-server` (Bun), `climon-beta` (Bun server JS bundle), and `climon-alpha`
 * (sentinel marker), with `.exe` on Windows binaries. dist/ contains only zips.
 *
 * Two modes:
 *   - **local / default**: build ONLY the host target's Rust client with cargo
 *     and emit just dist/climon-<host>.zip (so a developer can build + run on
 *     one machine).
 *   - **assemble** (CLIMON_ASSEMBLE=1): package all five zips from prebuilt Rust
 *     client binaries staged under dist/.rust-clients/<platform>/install[.exe]
 *     (used by the release CI matrix, which cross-compiles each client on its
 *     native runner).
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
const serverBundleEntrypoint = resolve(projectRoot, "src/server-bundle-entry.ts");
const embeddedAssetsPath = resolve(projectRoot, "src/server/embedded-assets.ts");

/** Contents of the self-install sentinel marker shipped as `climon-alpha`. */
const INSTALLER_SENTINEL =
  "climon self-install sentinel — its presence next to the executable triggers the native installer.\n";

const assembleMode = process.env.CLIMON_ASSEMBLE === "1";

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

export function zipEntryNamesForPlatform(platform: string): string[] {
  const isWindows = platform.startsWith("windows");
  const exe = isWindows ? ".exe" : "";
  return [`install${exe}`, `climon-server${exe}`, "climon-beta", "climon-alpha"];
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
 * Reads the prebuilt Rust client (`install`) binary staged for a platform at
 * dist/.rust-clients/<platform>/install[.exe]. Used in assemble mode; the bytes
 * are read up front, before dist/ is cleaned, so the clean does not delete them.
 */
function readStagedRustClient(platform: string): Uint8Array {
  const isWindows = platform.startsWith("windows");
  const exe = isWindows ? ".exe" : "";
  const staged = resolve(rustClientsStageDir, platform, `install${exe}`);
  if (!existsSync(staged)) {
    throw new Error(
      `Assemble mode: missing prebuilt Rust client for ${platform} at ${staged}`
    );
  }
  return new Uint8Array(readFileSync(staged));
}

/** Builds the host Rust client with cargo and returns its bytes (local mode). */
async function buildHostRustClient(platform: string): Promise<Uint8Array> {
  const isWindows = platform.startsWith("windows");
  const exe = isWindows ? ".exe" : "";
  console.log(`→ Building Rust client (cargo, ${platform})...`);
  await $`cargo build --release -p climon-cli`.cwd(rustDir);
  const built = resolve(rustDir, "target", "release", `climon${exe}`);
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
  if (assembleMode) {
    console.log("→ Assemble mode: loading prebuilt Rust clients...");
    for (const { platform } of targets) {
      rustClients.set(platform, readStagedRustClient(platform));
    }
  } else {
    const platform = targets[0].platform;
    rustClients.set(platform, await buildHostRustClient(platform));
  }

  // Step 1: Embed assets so the server binary serves the dashboard bundle.
  console.log("→ Embedding xterm assets...");
  await $`bun ${resolve(projectRoot, "scripts/embed-assets.ts")}`;

  // Step 2: Start from a clean dist/ so it ends up containing only zips.
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  try {
    mkdirSync(stageRoot, { recursive: true });

    // Build the server JS bundle once — it's platform-independent so the same
    // minified bundle is shared across all platform zips.
    const serverBundleOut = resolve(stageRoot, "climon-beta");
    console.log("→ Bundling climon-beta...");
    await $`bun build ${serverBundleEntrypoint} --define __CLIMON_EMBEDDED__=true --target bun --format esm --minify --outfile ${serverBundleOut}`;
    console.log(`  ✓ climon-beta (${(readFileSync(serverBundleOut).length / 1024).toFixed(0)} KB)`);

    // The installer is now native (in the Rust client). Ship a tiny sentinel
    // marker named climon-alpha — its presence triggers the self-install.
    const installerSentinelData = new TextEncoder().encode(INSTALLER_SENTINEL);
    console.log("→ Writing climon-alpha sentinel marker...");

    for (const { platform, target } of targets) {
      const isWindows = platform.startsWith("windows");
      const exe = isWindows ? ".exe" : "";
      const stageDir = resolve(stageRoot, platform);
      mkdirSync(stageDir, { recursive: true });

      const clientData = rustClients.get(platform);
      if (!clientData) throw new Error(`Missing Rust client for ${platform}`);

      const serverOut = resolve(stageDir, `climon-server${exe}`);
      console.log(`→ Compiling climon-server (${target})...`);
      const crossBin = await ensureCrossBinary(target);
      const execPathArgs = crossBin
        ? ["--compile-executable-path", crossBin]
        : [];
      await $`bun build ${serverEntrypoint} --compile --target ${target} ${execPathArgs} --outfile ${serverOut}`;

      // Read the produced binaries back and zip them under bare names. On Unix,
      // set os=3 + 0o755 perms so extracted binaries keep their executable bit.
      const fileOpts: ZipOptions = isWindows
        ? { level: 6 }
        : { level: 6, os: 3, attrs: 0o755 << 16 };

      const zipFiles: ZipEntry[] = [
        { name: `install${exe}`, data: clientData },
        { name: `climon-server${exe}`, path: serverOut },
        { name: "climon-beta", path: serverBundleOut },
        { name: "climon-alpha", data: installerSentinelData },
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
