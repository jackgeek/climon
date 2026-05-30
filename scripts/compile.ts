#!/usr/bin/env bun
/**
 * Cross-compiles climon into standalone binaries for Linux and macOS (x64 + arm64).
 * Runs the asset embedding step first, then invokes `bun build --compile` for each target.
 */
import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const projectRoot = dirname(dirname(import.meta.path));
const distDir = resolve(projectRoot, "dist");
const clientEntrypoint = resolve(projectRoot, "src/index.ts");
const serverEntrypoint = resolve(projectRoot, "src/server.ts");

const targets = [
  { name: "climon-linux-x64", target: "bun-linux-x64" },
  { name: "climon-linux-arm64", target: "bun-linux-arm64" },
  { name: "climon-darwin-x64", target: "bun-darwin-x64" },
  { name: "climon-darwin-arm64", target: "bun-darwin-arm64" },
];

async function main() {
  // Step 1: Embed assets
  console.log("→ Embedding xterm assets...");
  await $`bun ${resolve(projectRoot, "scripts/embed-assets.ts")}`;

  // Step 2: Ensure dist directory exists
  mkdirSync(distDir, { recursive: true });

  // Step 3: Compile a client and a server binary for each target
  for (const { name, target } of targets) {
    const clientOut = resolve(distDir, name);
    const serverName = name.replace(/^climon/, "climon-server");
    const serverOut = resolve(distDir, serverName);
    console.log(`→ Compiling ${name} (${target})...`);
    await $`bun build ${clientEntrypoint} --compile --target ${target} --outfile ${clientOut}`;
    console.log(`  ✓ ${clientOut}`);
    console.log(`→ Compiling ${serverName} (${target})...`);
    await $`bun build ${serverEntrypoint} --compile --target ${target} --outfile ${serverOut}`;
    console.log(`  ✓ ${serverOut}`);
  }

  console.log(`\n✓ All binaries written to ${distDir}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
