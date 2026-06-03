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
const embeddedAssetsPath = resolve(projectRoot, "src/server/embedded-assets.ts");

const targets = [
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
      const isWindows = target.includes("windows");
      const exe = isWindows ? ".exe" : "";
      const stageDir = resolve(stageRoot, platform);
      mkdirSync(stageDir, { recursive: true });

      const clientOut = resolve(stageDir, `climon${exe}`);
      const serverOut = resolve(stageDir, `climon-server${exe}`);

      console.log(`→ Compiling climon (${target})...`);
      await $`bun build ${clientEntrypoint} --compile --target ${target} --outfile ${clientOut}`;
      console.log(`→ Compiling climon-server (${target})...`);
      await $`bun build ${serverEntrypoint} --compile --define __CLIMON_EMBEDDED__=true --target ${target} --outfile ${serverOut}`;

      // Read the produced binaries back and zip them under bare names. On Unix,
      // set os=3 + 0o755 perms so extracted binaries keep their executable bit.
      const clientBin = new Uint8Array(readFileSync(clientOut));
      const serverBin = new Uint8Array(readFileSync(serverOut));
      const fileOpts: ZipOptions = isWindows
        ? { level: 6 }
        : { level: 6, os: 3, attrs: 0o755 << 16 };

      const zipped = zipSync({
        [`climon${exe}`]: [clientBin, fileOpts],
        [`climon-server${exe}`]: [serverBin, fileOpts],
      });

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
