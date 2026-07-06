#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";

const projectRoot = dirname(dirname(import.meta.path));
const rustWorkspace = resolve(projectRoot, "rust");
const isWindows = process.platform === "win32";
const binName = isWindows ? "climon.exe" : "climon";
const builtBin = join(rustWorkspace, "target", "debug", binName);

// Run the freshly built client from a *copy* rather than via `cargo run` /
// `target/debug/climon` directly. climon sessions (and the detached uplink they
// spawn) keep executing their binary for the whole session lifetime, and
// Windows locks a running executable against overwrite. If the dev binary were
// `target/debug/climon`, a still-running session would make the *next* build's
// link step fail with `Access is denied (os error 5)` — or, when another cargo
// holds the build-dir lock, block. Copying to a directory cargo never links
// into keeps `target/debug/climon` free to relink on every run, so a running
// session never breaks the edit/build/run loop.
const runDir = join(rustWorkspace, "target", "dev-run");

/**
 * `bun run dev`: build the Rust climon client (`climon` binary from the
 * `climon-cli` crate) and run it, forwarding any extra CLI args, e.g.
 * `bun run dev -- --help` or `bun run dev -- shell`.
 *
 * The build runs with inherited stdio and *without* `--quiet` so cargo's
 * `Compiling…` progress and `Blocking waiting for file lock` messages are
 * visible — otherwise a normal recompile (or a contended build-dir lock) looks
 * like the command has silently hung.
 *
 * stdio is inherited so the client owns the terminal (it attaches a PTY), and
 * SIGINT/SIGTERM are forwarded so Ctrl-C reaches the client cleanly. The script
 * exits with cargo's (on build failure) or the client's exit code.
 */

/**
 * Windows-only: kill any process still executing `target/debug/climon.exe`.
 *
 * cargo relinks that exact path on every build, and Windows locks a running
 * executable against overwrite, so a leftover process there makes the link step
 * fail with `Access is denied (os error 5)`. Nothing *should* run from that path
 * anymore — `bun dev` runs the staged copy in `runDir`, and daemons re-exec via
 * `current_exe()` (so they inherit the copy) — so any process found here is a
 * stale pre-fix leftover safe to terminate. Installed climon (in AppData) and
 * the staged copies run from different paths and are never touched.
 */
function killStaleBuildBinaryProcesses(): void {
  if (!isWindows) return;

  const script =
    `Get-CimInstance Win32_Process -Filter "Name='${binName}'" | ` +
    `Where-Object { $_.ExecutablePath -ieq '${builtBin.replace(/'/g, "''")}' } | ` +
    `ForEach-Object { $_.ProcessId }`;

  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout) return;

  const pids = result.stdout
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);

  for (const pid of pids) {
    try {
      process.kill(pid);
      process.stderr.write(
        `[dev] killed stale process ${pid} locking ${binName} (pre-fix leftover)\n`,
      );
    } catch {
      // Already gone or not killable; the build will surface any real lock.
    }
  }
}

/** Builds the client, showing cargo output. Returns the process exit code. */
function build(): number {
  const result = spawnSync(
    "cargo",
    ["build", "--package", "climon-cli", "--bin", "climon"],
    { cwd: rustWorkspace, stdio: "inherit" },
  );
  if (result.error) {
    const hint =
      (result.error as NodeJS.ErrnoException).code === "ENOENT"
        ? " (is the Rust toolchain / cargo installed and on PATH?)"
        : "";
    process.stderr.write(`[dev] failed to run cargo: ${result.error.message}${hint}\n`);
    return 127;
  }
  if (result.signal) {
    return 128 + (constants.signals[result.signal] ?? 0);
  }
  return result.status ?? 0;
}

/**
 * Copies the built binary to a per-build path in `runDir` and returns it. The
 * copy is keyed by the built binary's mtime so an unchanged build reuses the
 * same copy (no accumulation), and older, unlocked copies are pruned.
 */
function stageRunBinary(): string {
  mkdirSync(runDir, { recursive: true });
  const tag = Math.trunc(statSync(builtBin).mtimeMs);
  const ext = isWindows ? ".exe" : "";
  const runName = `climon-${tag}${ext}`;
  const runBin = join(runDir, runName);

  // Prune stale copies from previous builds. Skip any that are still locked by
  // a running session/uplink (EBUSY/EPERM) — cargo never touches them.
  for (const entry of readdirSync(runDir)) {
    if (entry === runName || !entry.startsWith("climon-")) continue;
    try {
      unlinkSync(join(runDir, entry));
    } catch {
      // Still in use by a running session; leave it.
    }
  }

  try {
    copyFileSync(builtBin, runBin);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // The copy for this exact build already exists and is locked by a running
    // session — reuse it. Executing an already-running binary is always fine.
    if (code !== "EBUSY" && code !== "EPERM") {
      throw err;
    }
  }
  return runBin;
}

/** Runs the staged client, forwarding args, signals, and the exit code. */
function run(runBin: string): Promise<number> {
  const extraArgs = process.argv.slice(2);

  return new Promise((resolveRun) => {
    const child = spawn(runBin, extraArgs, { cwd: rustWorkspace, stdio: "inherit" });

    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);

    child.on("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      // Mirror the conventional 128+signal exit code when killed by a signal.
      resolveRun(signal ? 128 + (constants.signals[signal] ?? 0) : code ?? 0);
    });

    child.on("error", (err) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      process.stderr.write(`[dev] failed to run climon: ${err.message}\n`);
      resolveRun(127);
    });
  });
}

async function main(): Promise<number> {
  killStaleBuildBinaryProcesses();
  const buildCode = build();
  if (buildCode !== 0) {
    return buildCode;
  }
  return run(stageRunBinary());
}

process.exitCode = await main();
