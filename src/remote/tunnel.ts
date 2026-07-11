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
import { rm, writeFile, chmod, rename } from "node:fs/promises";
import { hostname } from "node:os";
import { getRemoteHostPath } from "../config.js";
import {
  createDevtunnelGateway,
  devtunnelEnv,
  isDevtunnelDisabled,
  type DevtunnelGateway,
  type Runner,
  type RunResult
} from "../devtunnel/gateway.js";
import { ensureInstallId } from "../setup/install-id.js";
import { VERSION } from "../version.js";
import type { RemoteHostState } from "./ingest.js";
import {
  INGEST_TUNNEL_LABEL,
  deriveIngestTunnelId,
  buildIngestDescription,
  sanitizeHostForDescription
} from "./ingest-tunnel-id.js";

export { devtunnelEnv, isDevtunnelDisabled, type Runner, type RunResult };

const TUNNEL_ID = /^[a-z0-9][a-z0-9-]{1,47}[a-z0-9]$/;

type TunnelOptions = { env?: NodeJS.ProcessEnv; runner?: Runner; gateway?: DevtunnelGateway };

function gatewayFor(options: TunnelOptions = {}): DevtunnelGateway {
  return options.gateway ?? createDevtunnelGateway({ runner: options.runner, env: options.env });
}

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
export async function detectDevtunnel(input?: Runner | TunnelOptions): Promise<DetectResult> {
  const options = typeof input === "function" ? { runner: input } : input ?? {};
  const detected = await gatewayFor(options).detect();
  return { available: detected.available, version: detected.version };
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
  options: { devtunnelAvailable: boolean; env?: NodeJS.ProcessEnv; runner?: Runner; gateway?: DevtunnelGateway }
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
  options: TunnelOptions = {}
): Promise<RemoteHostState> {
  const env = options.env ?? process.env;
  const gateway = gatewayFor(options);

  const installId = ensureInstallId(env);
  const desiredId = deriveIngestTunnelId(installId);
  const host = sanitizeHostForDescription(hostname());
  const description = buildIngestDescription({ clientId: host, hostname: host, version: VERSION });

  const create = await gateway.createTunnel({
    id: desiredId,
    labels: [INGEST_TUNNEL_LABEL],
    description
  });
  const tunnelId = parseTunnelId(create.stdout) ?? desiredId;

  await gateway.createPort(tunnelId, ingestPort);

  const state: RemoteHostState = {
    tunnelId,
    ingestPort,
    canHost: true
  };
  await writeRemoteHostState(state, env);
  return state;
}

/**
 * Idempotently ensures the host's stable-id ingest tunnel exists and is recorded
 * as the desired hosting state. Reuses the tunnel if `devtunnel show` finds it;
 * otherwise creates it (with label + description). Safe to call on every startup.
 */
export async function ensureIngestTunnel(
  ingestPort: number,
  options: TunnelOptions = {}
): Promise<RemoteHostState> {
  const env = options.env ?? process.env;
  const gateway = gatewayFor(options);

  const installId = ensureInstallId(env);
  const desiredId = deriveIngestTunnelId(installId);

  let existingId: string;
  try {
    existingId = parseTunnelId(JSON.stringify(await gateway.showTunnel(desiredId))) ?? desiredId;
  } catch {
    return createTunnel(ingestPort, { env, gateway });
  }

  await gateway.createPort(existingId, ingestPort);

  const state: RemoteHostState = { tunnelId: existingId, ingestPort, canHost: true };
  await writeRemoteHostState(state, env);
  return state;
}

/** Tears down the recorded tunnel and removes the desired-state file. */
export async function deleteTunnel(
  options: TunnelOptions = {}
): Promise<void> {
  const gateway = gatewayFor(options);
  const env = options.env ?? process.env;
  const { readRemoteHostState } = await import("./ingest.js");
  const state = await readRemoteHostState(env);
  if (state?.canHost) {
    try {
      await gateway.deleteTunnel(state.tunnelId);
    } catch {
      // Preserve previous cleanup behavior even if the CLI delete command fails.
    }
  }
  await rm(getRemoteHostPath(env), { force: true });
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
  options: TunnelOptions = {}
): Promise<ReconcileResult> {
  const env = options.env ?? process.env;
  const gateway = gatewayFor(options);
  const { readRemoteHostState } = await import("./ingest.js");
  const state = await readRemoteHostState(env);

  if (!state) return { changed: false, port: actualPort };
  if (state.ingestPort === actualPort) return { changed: false, port: actualPort };

  if (state.canHost) {
    try {
      await gateway.deletePort(state.tunnelId, state.ingestPort);
    } catch {
      // The old port may already be gone; still try to add the desired mapping.
    }
    try {
      await gateway.createPort(state.tunnelId, actualPort);
    } catch {
      try {
        const fresh = await createTunnel(actualPort, { env, gateway });
        return { changed: true, port: fresh.ingestPort, recreated: true };
      } catch {
        // If even recreation fails, just update the state file so the port
        // is recorded correctly for `devtunnel host` next time.
      }
    }
  }

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
