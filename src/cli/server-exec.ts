import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeStderr } from "../logging/cli-io.js";

const SERVER_BIN_NAME = "climon-server";
const SERVER_BUNDLE_NAME = "climon-beta";

export interface ServerInvocation {
  file: string;
  args: string[];
}

export function resolveServerEnv(
  env: NodeJS.ProcessEnv,
  execPath: string,
  devEntrypoint?: string
): NodeJS.ProcessEnv {
  if (env.CLIMON_CLIENT_BIN?.trim() || devEntrypoint) {
    return env;
  }
  return { ...env, CLIMON_CLIENT_BIN: execPath };
}

/**
 * Resolves the path to a sibling encrypted server bundle that can be loaded
 * in-process. Returns undefined if no bundle is found.
 */
export function resolveServerBundle(
  env: NodeJS.ProcessEnv,
  execPath: string
): string | undefined {
  const override = env.CLIMON_SERVER_BUNDLE?.trim();
  if (override && existsSync(override)) return override;

  const sibling = join(dirname(execPath), SERVER_BUNDLE_NAME);
  if (existsSync(sibling)) return sibling;

  return undefined;
}

/**
 * Resolves how to launch the dashboard server, without spawning it.
 * Order: CLIMON_SERVER_BIN override → dev source entrypoint (when present) →
 * sibling of the running executable → bare name on PATH.
 *
 * Canonical contract: the spawned standalone `climon-server` binary is the
 * canonical server path, and the *only* path available to the future Rust
 * client (which cannot load the JS bundle in-process). The in-process bundle
 * preferred by `delegateToServer` is a Bun-client-only optimization that is
 * retired at Phase 12 of the Rust rewrite. Keep this resolution stable: the
 * Rust client relies on finding `climon-server[.exe]` as an installed sibling
 * (or via CLIMON_SERVER_BIN) exactly as resolved here.
 */
export function resolveServerInvocation(
  forwardArgs: string[],
  env: NodeJS.ProcessEnv,
  execPath: string,
  devEntrypoint?: string,
  platform: NodeJS.Platform = process.platform
): ServerInvocation {
  const override = env.CLIMON_SERVER_BIN?.trim();
  if (override) {
    return { file: override, args: forwardArgs };
  }

  if (devEntrypoint && existsSync(devEntrypoint)) {
    return { file: execPath, args: [devEntrypoint, ...forwardArgs] };
  }

  const exe = platform === "win32" ? ".exe" : "";
  const sibling = join(dirname(execPath), `${SERVER_BIN_NAME}${exe}`);
  if (existsSync(sibling)) {
    return { file: sibling, args: forwardArgs };
  }

  return { file: SERVER_BIN_NAME, args: forwardArgs };
}

/**
 * Runs the dashboard server in-process by importing the bundled server JS file.
 * Returns its exit code (0 on success).
 */
async function runServerInProcess(
  bundlePath: string,
  port: number | undefined,
  noTakeover: boolean | undefined
): Promise<number> {
  const mod = await import(bundlePath);
  if (typeof mod.startServer === "function") {
    await mod.startServer({ port, noTakeover });
    return 0;
  }
  if (typeof mod.default?.startServer === "function") {
    await mod.default.startServer({ port, noTakeover });
    return 0;
  }
  writeStderr(
    `climon: server bundle at ${bundlePath} does not export startServer()\n`
  );
  return 1;
}

/**
 * Resolves and runs the dashboard server. Prefers loading a sibling JS bundle
 * in-process (single process) over spawning a separate server binary.
 */
export async function delegateToServer(
  forwardArgs: string[],
  env: NodeJS.ProcessEnv,
  execPath: string,
  devEntrypoint?: string
): Promise<number> {
  const resolvedEnv = resolveServerEnv(env, execPath, devEntrypoint);
  const applyResolvedEnv = (): void => {
    Object.assign(process.env, resolvedEnv);
  };

  // In dev mode, just import the server source directly via a runtime path
  // so the bundler doesn't pull server code into the client binary.
  if (devEntrypoint && existsSync(devEntrypoint)) {
    // Set CLIMON_CLIENT_BIN before importing the in-process server so it can
    // reference the client executable for dashboard-spawned sessions.
    applyResolvedEnv();
    const { parseArgs } = await import("./args.js");
    const parsed = parseArgs(forwardArgs);
    if (parsed.command === "server") {
      const serverModPath = join(dirname(devEntrypoint), "server", "server.js");
      const mod = await import(serverModPath);
      await mod.startServer({ port: parsed.port, noTakeover: parsed.noTakeover });
      return 0;
    }
  }

  // Try loading a sibling JS bundle in-process (avoids spawning a 2nd process).
  const bundlePath = resolveServerBundle(env, execPath);
  if (bundlePath) {
    applyResolvedEnv();
    const { parseArgs } = await import("./args.js");
    const parsed = parseArgs(forwardArgs);
    if (parsed.command === "server") {
      return runServerInProcess(bundlePath, parsed.port, parsed.noTakeover);
    }
  }

  // Fallback: spawn a separate server binary.
  const { file, args } = resolveServerInvocation(forwardArgs, env, execPath, devEntrypoint);
  const result = spawnSync(file, args, {
    stdio: "inherit",
    env: resolvedEnv,
    windowsHide: true
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      writeStderr(
        `climon: the dashboard server (${SERVER_BIN_NAME}) is not installed.\n` +
          `Install the server binary alongside climon, or set CLIMON_SERVER_BIN to its path.\n`
      );
      return 127;
    }
    writeStderr(`climon: failed to start server: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 0;
}
