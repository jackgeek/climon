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
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { zipSync, type ZipOptions } from "fflate";

const projectRoot = dirname(dirname(import.meta.path));
const distDir = resolve(projectRoot, "dist");
const stageRoot = resolve(distDir, ".stage");
const clientEntrypoint = resolve(projectRoot, "src/index.ts");
const serverEntrypoint = resolve(projectRoot, "src/server.ts");
const installerEntrypoint = resolve(projectRoot, "src/install/index.ts");
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
  const names = [`climon${exe}`, `climon-server${exe}`];

  if (isWindows) {
    names.push("Setup.exe");
  }

  return names;
}

const targets: BuildTarget[] = [
  { platform: "linux-x64", target: "bun-linux-x64" },
  { platform: "linux-arm64", target: "bun-linux-arm64" },
  { platform: "darwin-x64", target: "bun-darwin-x64" },
  { platform: "darwin-arm64", target: "bun-darwin-arm64" },
  { platform: "windows-x64", target: "bun-windows-x64" },
];

async function main() {
  // Step 1: Embed assets so the server binary serves the dashboard bundle.
  console.log("→ Embedding xterm assets...");
  await $`bun ${resolve(projectRoot, "scripts/embed-assets.ts")}`;

  // Step 2: Start from a clean dist/ so it ends up containing only zips.
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  try {
    for (const { platform, target } of targets) {
      const isWindows = platform.startsWith("windows");
      const exe = isWindows ? ".exe" : "";
      const stageDir = resolve(stageRoot, platform);
      mkdirSync(stageDir, { recursive: true });

      const clientOut = resolve(stageDir, `climon${exe}`);
      const serverOut = resolve(stageDir, `climon-server${exe}`);
      const installerOut = isWindows ? resolve(stageDir, "Setup.exe") : undefined;

      console.log(`→ Compiling climon (${target})...`);
      await $`bun build ${clientEntrypoint} --compile --target ${target} --outfile ${clientOut}`;
      console.log(`→ Compiling climon-server (${target})...`);
      await $`bun build ${serverEntrypoint} --compile --define __CLIMON_EMBEDDED__=true --target ${target} --outfile ${serverOut}`;
      if (installerOut) {
        console.log(`→ Compiling Setup.exe (${target})...`);
        await $`bun build ${installerEntrypoint} --compile --target ${target} --outfile ${installerOut}`;
      }

      // Read the produced binaries back and zip them under bare names. On Unix,
      // set os=3 + 0o755 perms so extracted binaries keep their executable bit.
      const fileOpts: ZipOptions = isWindows
        ? { level: 6 }
        : { level: 6, os: 3, attrs: 0o755 << 16 };

      const zipFiles: ZipEntry[] = [
        { name: `climon${exe}`, path: clientOut },
        { name: `climon-server${exe}`, path: serverOut },
      ];

      if (installerOut) {
        zipFiles.push({ name: "Setup.exe", path: installerOut });
      }

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
