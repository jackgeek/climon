/**
 * ⚠️ LEGACY TypeScript client — frozen. Fix the Rust client instead.
 *
 * The shipping `climon` *client* is the Rust workspace under `rust/` (crates
 * `climon-cli`, `climon-session`, `climon-pty`, `climon-store`, `climon-config`,
 * `climon-remote`, `climon-install`, `climon-update`, …). This module belongs to
 * the legacy Bun/TypeScript client, kept only for local development and the Bun
 * test suite. Do NOT add features or fix client bugs here — make all client
 * changes in the Rust crates. (The Bun dashboard *server* under `src/server*`
 * and `src/web/` is NOT legacy and is still maintained.)
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

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
    // Only honor an ABSOLUTE override: a relative path would resolve against
    // the (possibly attacker-influenced) cwd, allowing client-binary hijack.
    if (isAbsolute(override)) {
      return { file: override, args: forwardArgs };
    }
    process.stderr.write(
      `climon: warning: ignoring non-absolute CLIMON_CLIENT_BIN=${override}; ` +
        `it must be an absolute path.\n`
    );
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
