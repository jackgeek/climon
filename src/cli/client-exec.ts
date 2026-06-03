import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const CLIENT_BIN_NAME = "climon";

export interface ClientInvocation {
  file: string;
  args: string[];
}

/**
 * Resolves how to launch the climon client binary, without spawning it.
 * Order: CLIMON_CLIENT_BIN override -> sibling of the running executable ->
 * dev source entrypoint (when present) -> bare name on PATH. Mirrors
 * resolveServerInvocation so the server can spawn sessions via the client.
 */
export function resolveClientInvocation(
  forwardArgs: string[],
  env: NodeJS.ProcessEnv,
  execPath: string,
  devEntrypoint?: string,
  platform: NodeJS.Platform = process.platform
): ClientInvocation {
  const override = env.CLIMON_CLIENT_BIN?.trim();
  if (override) {
    return { file: override, args: forwardArgs };
  }

  const exe = platform === "win32" ? ".exe" : "";
  const sibling = join(dirname(execPath), `${CLIENT_BIN_NAME}${exe}`);
  if (existsSync(sibling)) {
    return { file: sibling, args: forwardArgs };
  }

  if (devEntrypoint && existsSync(devEntrypoint)) {
    return { file: execPath, args: [devEntrypoint, ...forwardArgs] };
  }

  return { file: CLIENT_BIN_NAME, args: forwardArgs };
}
