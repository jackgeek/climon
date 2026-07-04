#!/usr/bin/env bun
/**
 * `build:rust` step of `bun run build`: builds the Rust `climon` client
 * (`rust/climon-cli`).
 *
 * Cargo is located via the shared toolchain helper (PATH or rustup's default
 * bin dir) and installed if missing, so the build works right after
 * `bun install` even when ~/.cargo/bin is not yet on this shell's PATH. The
 * cargo bin dir is prepended to PATH for the child so cargo can find its
 * rustc/linker shims.
 */
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { cargoBinDir, ensureRust } from "./rust-toolchain.js";

const projectRoot = dirname(dirname(import.meta.path));
const rustDir = join(projectRoot, "rust");

const cargo = await ensureRust();

const env = { ...process.env };
env.PATH = `${cargoBinDir()}${delimiter}${env.PATH ?? ""}`;

console.log(`→ Building Rust client (${cargo} build -p climon-cli)...`);
const result = spawnSync(cargo, ["build", "-p", "climon-cli"], {
  cwd: rustDir,
  stdio: "inherit",
  env,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
