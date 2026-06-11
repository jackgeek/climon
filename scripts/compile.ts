#!/usr/bin/env bun
/**
 * Cross-compiles climon + climon-server for every supported platform and packages
 * each platform's two binaries into a single zip named after the platform.
 *
 * Output: dist/climon-<platform>.zip, each containing bare-named `climon` and
 * `climon-server` binaries (with `.exe` on Windows). dist/ contains only zips.
 *
 * Runs the asset-embedding step first, then `bun build --compile` per target.
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
const distDir = resolve(projectRoot, "dist");
const stageRoot = resolve(distDir, ".stage");
const clientEntrypoint = resolve(projectRoot, "src/index.ts");
const serverBundleEntrypoint = resolve(projectRoot, "src/server-bundle-entry.ts");
const installerBundleEntrypoint = resolve(projectRoot, "src/installer-bundle-entry.ts");
const embeddedAssetsPath = resolve(projectRoot, "src/server/embedded-assets.ts");

type BuildTarget = {
  platform: string;
  target: string;
};

type ZipEntry = {
  name: string;
  path: string;
};

export function zipEntryNamesForPlatform(platform: string): string[] {
  const isWindows = platform.startsWith("windows");
  const exe = isWindows ? ".exe" : "";
  return [`climon${exe}`, "climon-server", "climon-installer"];
}

const targets: BuildTarget[] = [
  { platform: "linux-x64", target: "bun-linux-x64" },
  { platform: "linux-arm64", target: "bun-linux-arm64" },
  { platform: "darwin-x64", target: "bun-darwin-x64" },
  { platform: "darwin-arm64", target: "bun-darwin-arm64" },
  { platform: "windows-x64", target: "bun-windows-x64" },
];

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

async function main() {
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
    const serverBundleOut = resolve(stageRoot, "climon-server");
    console.log("→ Bundling climon-server...");
    await $`bun build ${serverBundleEntrypoint} --define __CLIMON_EMBEDDED__=true --target bun --format esm --minify --outfile ${serverBundleOut}`;
    console.log(`  ✓ climon-server (${(readFileSync(serverBundleOut).length / 1024).toFixed(0)} KB)`);

    // Build the installer JS bundle once — also platform-independent.
    const installerBundleOut = resolve(stageRoot, "climon-installer");
    console.log("→ Bundling climon-installer...");
    await $`bun build ${installerBundleEntrypoint} --target bun --format esm --minify --outfile ${installerBundleOut}`;
    console.log(`  ✓ climon-installer (${(readFileSync(installerBundleOut).length / 1024).toFixed(0)} KB)`);

    for (const { platform, target } of targets) {
      const isWindows = platform.startsWith("windows");
      const exe = isWindows ? ".exe" : "";
      const stageDir = resolve(stageRoot, platform);
      mkdirSync(stageDir, { recursive: true });

      const clientOut = resolve(stageDir, `climon${exe}`);

      console.log(`→ Compiling climon (${target})...`);
      const crossBin = await ensureCrossBinary(target);
      const execPathArgs = crossBin
        ? ["--compile-executable-path", crossBin]
        : [];
      await $`bun build ${clientEntrypoint} --compile --target ${target} ${execPathArgs} --outfile ${clientOut}`;

      // Read the produced binaries back and zip them under bare names. On Unix,
      // set os=3 + 0o755 perms so extracted binaries keep their executable bit.
      const fileOpts: ZipOptions = isWindows
        ? { level: 6 }
        : { level: 6, os: 3, attrs: 0o755 << 16 };

      const zipFiles: ZipEntry[] = [
        { name: `climon${exe}`, path: clientOut },
        { name: "climon-server", path: serverBundleOut },
        { name: "climon-installer", path: installerBundleOut },
      ];

      const zipEntries: Record<string, [Uint8Array, ZipOptions]> = {};

      for (const { name, path } of zipFiles) {
        zipEntries[name] = [new Uint8Array(readFileSync(path)), fileOpts];
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
    rmSync(embeddedAssetsPath, { force: true });
  }

  console.log(`\n✓ All platform zips written to ${distDir}/`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
