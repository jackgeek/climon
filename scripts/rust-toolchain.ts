#!/usr/bin/env bun
/**
 * Rust toolchain bootstrap for climon's Bun-driven build.
 *
 * climon's client is a Rust binary (`rust/climon-cli`), so `bun run build`
 * needs `cargo`. To keep local setup to just `bun install` followed by
 * `bun run build`, the package `postinstall` hook runs this module to report
 * whether a Rust toolchain is present. If cargo is missing it only prints a
 * heads-up (no download) so `bun install` stays lightweight — including on
 * server-only CI that never builds the client. The toolchain is installed
 * lazily, on demand, by `scripts/build-rust.ts` (the `build:rust` step), which
 * calls `ensureRust()` and surfaces a hard error if it cannot be provisioned.
 *
 * Set CLIMON_SKIP_RUST_INSTALL=1 to skip the automatic rustup download (useful
 * in locked-down/offline environments that provision Rust another way).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.platform === "win32" ? ".exe" : "";

/** Directory rustup installs cargo/rustc into (honours CARGO_HOME). */
export function cargoBinDir(): string {
  const cargoHome = process.env.CARGO_HOME;
  const base =
    cargoHome && cargoHome.length > 0 ? cargoHome : join(homedir(), ".cargo");
  return join(base, "bin");
}

/**
 * Resolves a usable cargo path, checking PATH first and then rustup's default
 * install location (so a freshly installed toolchain works even before
 * ~/.cargo/bin has been added to PATH). Returns null when cargo is absent.
 */
export function findCargo(): string | null {
  const locator = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(locator, ["cargo"], { encoding: "utf8" });
  if (found.status === 0) {
    const first = found.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (first) return first;
  }
  const candidate = join(cargoBinDir(), `cargo${exe}`);
  return existsSync(candidate) ? candidate : null;
}

/** Downloads and runs rustup non-interactively (minimal profile, stable). */
async function installRustup(): Promise<void> {
  console.log(
    "→ cargo not found; installing the Rust toolchain via rustup (minimal profile)...",
  );
  const toolchainArgs = [
    "-y",
    "--profile",
    "minimal",
    "--default-toolchain",
    "stable",
  ];

  if (process.platform === "win32") {
    const url =
      process.arch === "arm64"
        ? "https://win.rustup.rs/aarch64"
        : "https://win.rustup.rs/x86_64";
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to download rustup-init.exe: ${res.status} ${res.statusText}`,
      );
    }
    // rustup-init.exe is a multi-call binary that dispatches on its own file
    // name, so it MUST be named exactly `rustup-init.exe`. Stage it in a unique
    // temp subdirectory to keep the required name while avoiding collisions.
    const initDir = mkdtempSync(join(tmpdir(), "climon-rustup-"));
    const initPath = join(initDir, "rustup-init.exe");
    await Bun.write(initPath, res);
    const install = spawnSync(initPath, toolchainArgs, { stdio: "inherit" });
    if (install.status !== 0) {
      throw new Error(`rustup-init.exe exited with code ${install.status}`);
    }
    return;
  }

  const res = await fetch("https://sh.rustup.rs");
  if (!res.ok) {
    throw new Error(
      `Failed to download rustup installer: ${res.status} ${res.statusText}`,
    );
  }
  const script = await res.text();
  const install = spawnSync("sh", ["-s", "--", ...toolchainArgs], {
    input: script,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (install.status !== 0) {
    throw new Error(`rustup installer exited with code ${install.status}`);
  }
}

/**
 * Ensures a Rust toolchain is available and returns the cargo path, installing
 * rustup when it is missing. Throws if cargo cannot be provisioned.
 */
export async function ensureRust(): Promise<string> {
  const existing = findCargo();
  if (existing) return existing;

  if (process.env.CLIMON_SKIP_RUST_INSTALL === "1") {
    throw new Error(
      "cargo not found and CLIMON_SKIP_RUST_INSTALL=1; install Rust from https://rustup.rs",
    );
  }

  await installRustup();
  const cargo = findCargo();
  if (!cargo) {
    throw new Error(
      "Rust toolchain installation completed but cargo could not be located",
    );
  }
  return cargo;
}

// When run directly (the `postinstall` hook) this only reports toolchain
// status — it never downloads Rust and never fails `bun install`. The actual
// install happens lazily in `build:rust` (scripts/build-rust.ts).
if (import.meta.main) {
  const cargo = findCargo();
  if (cargo) {
    console.log(`✓ Rust toolchain detected (${cargo})`);
  } else {
    console.log(
      "ℹ Rust toolchain (cargo) not found — `bun run build` will install it on first client build.",
    );
    console.log(
      "  To provision it yourself instead, install Rust from https://rustup.rs.",
    );
  }
}
