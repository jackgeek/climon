import { networkInterfaces } from "node:os";
import { resolveConfigSetting } from "../config.js";
import { isWsl } from "./peer.js";

const LOOPBACK = "127.0.0.1";

export interface ResolveIngestBindHostDeps {
  /** Network interface map; defaults to os.networkInterfaces(). Injected for tests. */
  interfaces?: () => ReturnType<typeof networkInterfaces>;
  /** Whether this process runs inside WSL; defaults to the real detector. */
  isWsl?: (env: NodeJS.ProcessEnv) => boolean;
  /** Resolves the optional `remote.ingestHost` override; injected for tests. */
  configuredHost?: (env: NodeJS.ProcessEnv) => string | undefined;
}

function defaultConfiguredHost(env: NodeJS.ProcessEnv): string | undefined {
  const value = resolveConfigSetting("remote.ingestHost", env);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * IPv4 address of the Windows-side `vEthernet (WSL)` adapter — the interface a
 * Windows-hosted ingest must bind so the WSL VM can reach it over the default-NAT
 * gateway. Matches the adapter name case-insensitively on "WSL" (e.g.
 * "vEthernet (WSL (Hyper-V firewall))"), which excludes "vEthernet (Default
 * Switch)". Returns undefined when no such adapter exists.
 */
export function findWslVEthernetIPv4(ifaces: ReturnType<typeof networkInterfaces>): string | undefined {
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!/WSL/i.test(name) || !addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal && addr.address) return addr.address;
    }
  }
  return undefined;
}

/**
 * Resolves the host the ingest binds so the PEER OS can reach it (spec Component 3):
 *   1. an explicit `remote.ingestHost` override, else
 *   2. WSL host -> 127.0.0.1 (Windows reaches it via WSL2 localhost-forwarding), else
 *   3. Windows host -> the `vEthernet (WSL)` IPv4 (WSL reaches it via the NAT gateway), else
 *   4. loopback fallback (no WSL adapter — e.g. mirrored networking).
 */
export function resolveIngestBindHost(
  env: NodeJS.ProcessEnv = process.env,
  deps: ResolveIngestBindHostDeps = {}
): string {
  const ifaces = deps.interfaces ?? networkInterfaces;
  const wsl = deps.isWsl ?? isWsl;
  const configuredHost = deps.configuredHost ?? defaultConfiguredHost;

  const override = configuredHost(env);
  if (override) return override;
  if (wsl(env)) return LOOPBACK;
  const vEthernet = findWslVEthernetIPv4(ifaces());
  if (vEthernet) return vEthernet;
  return LOOPBACK;
}
