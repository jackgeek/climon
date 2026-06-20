#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { dirname, resolve } from "node:path";

const projectRoot = dirname(dirname(import.meta.path));
const rustWorkspace = resolve(projectRoot, "rust");

/**
 * `bun run dev`: build and run the Rust climon client (`climon` binary from the
 * `climon-cli` crate) straight from source via `cargo run`, forwarding any extra
 * CLI args, e.g. `bun run dev -- --help` or `bun run dev -- list`.
 *
 * stdio is inherited so the client owns the terminal (it attaches a PTY), and
 * SIGINT/SIGTERM are forwarded so Ctrl-C reaches the client cleanly. The script
 * exits with cargo's (and therefore the client's) exit code.
 */
function main(): Promise<number> {
  const extraArgs = process.argv.slice(2);

  return new Promise((resolveRun) => {
    const child = spawn(
      "cargo",
      ["run", "--quiet", "--package", "climon-cli", "--bin", "climon", "--", ...extraArgs],
      { cwd: rustWorkspace, stdio: "inherit" },
    );

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
      const hint =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? " (is the Rust toolchain / cargo installed and on PATH?)"
          : "";
      process.stderr.write(`[dev] failed to run cargo: ${err.message}${hint}\n`);
      resolveRun(127);
    });
  });
}

process.exitCode = await main();
