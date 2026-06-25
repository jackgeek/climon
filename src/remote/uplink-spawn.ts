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
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveClientInvocation } from "../cli/client-exec.js";

function resolveDevClientEntrypoint(): string | undefined {
  if (!import.meta.url.startsWith("file:")) return undefined;
  try {
    const candidate = fileURLToPath(new URL("../index.ts", import.meta.url));
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Spawns a detached `__uplink` via the climon client binary. Used by the ingest
 * daemon and the dashboard server (both run as the server binary) to push this
 * OS's local sessions to the new host during a handoff. The uplink self-targets
 * the new host via peer discovery, so no host address is passed in.
 */
export function spawnUplinkDetached(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath
): void {
  const inv = resolveClientInvocation(["__uplink"], env, execPath, resolveDevClientEntrypoint());
  const child = spawn(inv.file, inv.args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}
