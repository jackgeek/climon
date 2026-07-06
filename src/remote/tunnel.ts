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
import { rm, writeFile, chmod, rename } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { getRemoteHostPath } from "../config.js";
import { ensureInstallId } from "../setup/install-id.js";
import { VERSION } from "../version.js";
import type { RemoteHostState } from "./ingest.js";
import {
  INGEST_TUNNEL_LABEL,
  deriveIngestTunnelId,
  buildIngestDescription,
  sanitizeHostForDescription
} from "./ingest-tunnel-id.js";

const TUNNEL_ID = /^[a-z0-9][a-z0-9-]{1,47}[a-z0-9]$/;

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

export function devtunnelEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (env.LD_LIBRARY_PATH) return env;
  const icuLib = join(env.HOME ?? homedir(), ".local", "icu", "usr", "lib", "x86_64-linux-gnu");
  return existsSync(icuLib) ? { ...env, LD_LIBRARY_PATH: icuLib } : env;
}

/** True when the CLIMON_DISABLE_DEVTUNNEL env flag disables all devtunnel interaction. */
export function isDevtunnelDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CLIMON_DISABLE_DEVTUNNEL;
  return v === "1" || v === "true";
}

const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    if (cmd === "devtunnel" && isDevtunnelDisabled()) {
      resolve({ status: 127, stdout: "", stderr: "devtunnel disabled" });
      return;
    }
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: cmd === "devtunnel" ? devtunnelEnv() : process.env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", () => resolve({ status: 127, stdout, stderr: "spawn failed" }));
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
  });

/** Extracts a tunnel id from a bare id or a https://<id>-<port>.<region>.devtunnels.ms/ URL. */
export function parseTunnelInput(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const urlMatch = trimmed.match(/^https?:\/\/([a-z0-9][a-z0-9-]{1,47}[a-z0-9])-\d+\.[^/]*devtunnels\.ms/i);
  const candidate = urlMatch ? urlMatch[1] : trimmed;
  return TUNNEL_ID.test(candidate) ? candidate : undefined;
}

export interface DetectResult {
  available: boolean;
  version?: string;
}

/** Confirms the `devtunnel` CLI is present and runnable. */
export async function detectDevtunnel(runner: Runner = defaultRunner): Promise<DetectResult> {
  if (isDevtunnelDisabled()) return { available: false };
  const res = await runner("devtunnel", ["--version"]);
  if (res.status !== 0) return { available: false };
  return { available: true, version: res.stdout.trim() || undefined };
}

/** Atomically persists the desired tunnel-hosting state so fs.watch never sees a torn file. */
async function writeRemoteHostState(state: RemoteHostState, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = getRemoteHostPath(env);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
  } catch {
    // Non-POSIX filesystems.
  }
  await rename(tmp, path);
}

export interface ManualTunnelInput {
  tunnelId: string;
  ingestPort: number;
}

/** Records a user-supplied tunnel as the desired hosting state. */
export async function useManualTunnel(
  input: ManualTunnelInput,
  options: { devtunnelAvailable: boolean; env?: NodeJS.ProcessEnv; runner?: Runner }
): Promise<RemoteHostState> {
  const state: RemoteHostState = {
    tunnelId: input.tunnelId,
    ingestPort: input.ingestPort,
    canHost: options.devtunnelAvailable
  };
  await writeRemoteHostState(state, options.env);
  return state;
}

/**
 * Auto-creates a tunnel and a port mapping for the ingest port, then records
 * it as the desired hosting state. The tunnel uses identity-based access
 * (the connecting side must be logged into `devtunnel` with an authorized identity).
 *
 * VERIFY the exact devtunnel subcommands/flags below against the installed CLI.
 */
export async function createTunnel(
  ingestPort: number,
  options: { env?: NodeJS.ProcessEnv; runner?: Runner } = {}
): Promise<RemoteHostState> {
  const env = options.env ?? process.env;
  const runner = options.runner ?? defaultRunner;

  const installId = ensureInstallId(env);
  const desiredId = deriveIngestTunnelId(installId);
  const host = sanitizeHostForDescription(hostname());
  const description = buildIngestDescription({ clientId: host, hostname: host, version: VERSION });

  const create = await runner("devtunnel", [
    "create",
    desiredId,
    "--labels",
    INGEST_TUNNEL_LABEL,
    "--description",
    description,
    "--json"
  ]);
  if (create.status !== 0) {
    throw new Error(`devtunnel create failed: ${create.stderr.trim() || create.status}`);
  }
  const tunnelId = parseTunnelId(create.stdout) ?? desiredId;

  const portRes = await runner("devtunnel", ["port", "create", tunnelId, "-p", String(ingestPort)]);
  if (portRes.status !== 0) {
    throw new Error(`devtunnel port create failed: ${portRes.stderr.trim() || portRes.status}`);
  }

  const state: RemoteHostState = {
    tunnelId,
    ingestPort,
    canHost: true
  };
  await writeRemoteHostState(state, env);
  return state;
}

/** Tears down the recorded tunnel and removes the desired-state file. */
export async function deleteTunnel(
  options: { env?: NodeJS.ProcessEnv; runner?: Runner } = {}
): Promise<void> {
  const runner = options.runner ?? defaultRunner;
  const { readRemoteHostState } = await import("./ingest.js");
  const state = await readRemoteHostState(options.env ?? process.env);
  if (state?.canHost) {
    await runner("devtunnel", ["delete", state.tunnelId]);
  }
  await rm(getRemoteHostPath(options.env ?? process.env), { force: true });
}

export interface ReconcileResult {
  /** Whether the port mapping was updated. */
  changed: boolean;
  /** The port the tunnel now forwards to. */
  port: number;
  /** If reconciliation failed and the tunnel was recreated from scratch. */
  recreated?: boolean;
}

/**
 * Ensures the tunnel's port mapping matches the ingest's actual bound port.
 * If the port in remote-host.json differs from the live ingest port, updates
 * the devtunnel port mapping (delete old, create new). If the port update fails
 * (e.g. the tunnel was deleted externally), falls back to full tunnel recreation.
 * No-op if there is no configured tunnel or the ports already match.
 */
export async function reconcileTunnelPort(
  actualPort: number,
  options: { env?: NodeJS.ProcessEnv; runner?: Runner } = {}
): Promise<ReconcileResult> {
  const env = options.env ?? process.env;
  const runner = options.runner ?? defaultRunner;
  const { readRemoteHostState } = await import("./ingest.js");
  const state = await readRemoteHostState(env);

  if (!state) return { changed: false, port: actualPort };
  if (state.ingestPort === actualPort) return { changed: false, port: actualPort };

  // Port mismatch — update the tunnel's port mapping.
  if (state.canHost) {
    // Try to delete the old port and create the new one.
    const delRes = await runner("devtunnel", ["port", "delete", state.tunnelId, "-p", String(state.ingestPort)]);
    const addRes = await runner("devtunnel", ["port", "create", state.tunnelId, "-p", String(actualPort)]);
    if (addRes.status !== 0) {
      // Tunnel might have been deleted externally — try full recreation.
      try {
        const fresh = await createTunnel(actualPort, { env, runner });
        return { changed: true, port: fresh.ingestPort, recreated: true };
      } catch {
        // If even recreation fails, just update the state file so the port
        // is recorded correctly for `devtunnel host` next time.
      }
    } else if (delRes.status !== 0) {
      // Old port didn't exist (maybe already deleted) but new port was added — fine.
    }
  }

  // Update the persisted state to reflect the actual port.
  const updated: RemoteHostState = { ...state, ingestPort: actualPort };
  await writeRemoteHostState(updated, env);
  return { changed: true, port: actualPort };
}

function parseTunnelId(stdout: string): string | undefined {
  try {
    const obj = JSON.parse(stdout) as { tunnelId?: string; tunnel?: { tunnelId?: string } };
    return obj.tunnelId ?? obj.tunnel?.tunnelId;
  } catch {
    const m = stdout.match(/\b([a-z0-9]{6,})\b/i);
    return m?.[1];
  }
}
