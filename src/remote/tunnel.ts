import { spawn } from "node:child_process";
import { rm, writeFile, chmod, rename } from "node:fs/promises";
import { getRemoteHostPath } from "../config.js";
import type { RemoteHostState } from "./ingest.js";

const TUNNEL_ID = /^[a-z0-9][a-z0-9-]{1,47}[a-z0-9]$/;

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
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
  connectToken: string;
  ingestPort: number;
  tokenExpiresAt?: string;
}

/** Records a user-supplied tunnel as the desired hosting state. */
export async function useManualTunnel(
  input: ManualTunnelInput,
  options: { devtunnelAvailable: boolean; env?: NodeJS.ProcessEnv; runner?: Runner }
): Promise<RemoteHostState> {
  const state: RemoteHostState = {
    tunnelId: input.tunnelId,
    connectToken: input.connectToken,
    ingestPort: input.ingestPort,
    tokenExpiresAt: input.tokenExpiresAt,
    canHost: options.devtunnelAvailable
  };
  await writeRemoteHostState(state, options.env);
  return state;
}

/**
 * Auto-creates a tunnel and a port mapping for the ingest port, issues a
 * connect-scoped token, and records it as the desired hosting state.
 *
 * VERIFY the exact devtunnel subcommands/flags below against the installed CLI.
 */
export async function createTunnel(
  ingestPort: number,
  options: { env?: NodeJS.ProcessEnv; runner?: Runner } = {}
): Promise<RemoteHostState> {
  const runner = options.runner ?? defaultRunner;
  const create = await runner("devtunnel", ["create", "--json"]);
  if (create.status !== 0) {
    throw new Error(`devtunnel create failed: ${create.stderr.trim() || create.status}`);
  }
  const tunnelId = parseTunnelId(create.stdout);
  if (!tunnelId) throw new Error("Could not parse tunnel id from `devtunnel create` output.");

  const portRes = await runner("devtunnel", ["port", "create", tunnelId, "-p", String(ingestPort)]);
  if (portRes.status !== 0) {
    throw new Error(`devtunnel port create failed: ${portRes.stderr.trim() || portRes.status}`);
  }

  const tokenRes = await runner("devtunnel", ["token", tunnelId, "--scopes", "connect", "--json"]);
  if (tokenRes.status !== 0) {
    throw new Error(`devtunnel token failed: ${tokenRes.stderr.trim() || tokenRes.status}`);
  }
  const { token, expiresAt } = parseToken(tokenRes.stdout);
  if (!token) throw new Error("Could not parse connect token from `devtunnel token` output.");

  const state: RemoteHostState = {
    tunnelId,
    connectToken: token,
    ingestPort,
    tokenExpiresAt: expiresAt,
    canHost: true
  };
  await writeRemoteHostState(state, options.env);
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

function parseTunnelId(stdout: string): string | undefined {
  try {
    const obj = JSON.parse(stdout) as { tunnelId?: string; tunnel?: { tunnelId?: string } };
    return obj.tunnelId ?? obj.tunnel?.tunnelId;
  } catch {
    const m = stdout.match(/\b([a-z0-9]{6,})\b/i);
    return m?.[1];
  }
}

function parseToken(stdout: string): { token?: string; expiresAt?: string } {
  try {
    const obj = JSON.parse(stdout) as { token?: string; expiration?: string; expiresAt?: string };
    return { token: obj.token, expiresAt: obj.expiration ?? obj.expiresAt };
  } catch {
    return { token: stdout.trim() || undefined };
  }
}
