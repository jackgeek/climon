import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const SERVER_BIN_NAME = "climon-server";

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
 * Resolves how to launch the dashboard server, without spawning it.
 * Order: CLIMON_SERVER_BIN override → dev source entrypoint (when present) →
 * sibling of the running executable → bare name on PATH.
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
 * Resolves and runs the dashboard server with inherited stdio, returning its
 * exit code. Prints an actionable message when the server binary is missing.
 */
export function delegateToServer(
  forwardArgs: string[],
  env: NodeJS.ProcessEnv,
  execPath: string,
  devEntrypoint?: string
): number {
  const { file, args } = resolveServerInvocation(forwardArgs, env, execPath, devEntrypoint);
  const result = spawnSync(file, args, {
    stdio: "inherit",
    env: resolveServerEnv(env, execPath, devEntrypoint),
    windowsHide: true
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(
        `climon: the dashboard server (${SERVER_BIN_NAME}) is not installed.\n` +
          `Install the climon-server binary alongside climon, or set CLIMON_SERVER_BIN to its path.\n`
      );
      return 127;
    }
    process.stderr.write(`climon: failed to start server: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 0;
}
