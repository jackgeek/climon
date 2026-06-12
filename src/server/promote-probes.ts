import { rm } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { resolveConfigSetting } from "../config.js";
import { readIngestStateFromDir } from "../remote/ingest-state.js";
import { peerHostCandidates } from "../remote/peer.js";
import { writeShutdownRequestToDir, type ShutdownRequest } from "../remote/shutdown-request.js";
import { readServerStateFromDir } from "../server-state.js";
import type { IngestTarget, PromoteDeps } from "./promote.js";

const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const DEFAULT_CONFIRM_TIMEOUT_MS = 5000;
const DEFAULT_CONFIRM_POLL_MS = 100;

export interface PromoteTiming {
  probeTimeoutMs?: number;
  confirmTimeoutMs?: number;
  confirmPollMs?: number;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Builds the injected promote dependencies for a configured peer. Coordination
 * is entirely over the shared filesystem plus a single data-plane-reachable TCP
 * probe of the peer ingest's PUBLISHED host (falling back to the candidate list:
 * an explicit `remote.peerHost`, else loopback then the WSL gateway). The
 * shutdown-request carries no token — same-user write access to the peer home is
 * the authorization.
 */
export function buildPromoteDeps(
  peerHome: string,
  env: NodeJS.ProcessEnv,
  peerLabel: string,
  log: (message: string) => void = () => {},
  timing: PromoteTiming = {}
): PromoteDeps {
  const probeTimeoutMs = timing.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const confirmTimeoutMs = timing.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const confirmPollMs = timing.confirmPollMs ?? DEFAULT_CONFIRM_POLL_MS;
  const override = asString(resolveConfigSetting("remote.peerHost", env, process.cwd()));
  // requestedBy is the LOCAL OS label (diagnostics only), the opposite of the peer.
  const requestedBy = peerLabel === "WSL" ? "Windows" : "WSL";

  const tcpConnectable = (host: string, port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = connect({ host, port });
      const done = (result: boolean): void => {
        socket.destroy();
        resolve(result);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(probeTimeoutMs, () => done(false));
    });

  const candidatesFor = (target: IngestTarget): string[] => {
    const list: string[] = [];
    if (target.host) list.push(target.host);
    for (const host of override ? [override] : peerHostCandidates(env)) {
      if (!list.includes(host)) list.push(host);
    }
    return list;
  };

  const anyListening = async (target: IngestTarget): Promise<boolean> => {
    for (const host of candidatesFor(target)) {
      if (await tcpConnectable(host, target.port)) {
        log(`peer ingest reachable at ${host}:${target.port}`);
        return true;
      }
    }
    return false;
  };

  const pollUntil = async (predicate: () => Promise<boolean>): Promise<boolean> => {
    const deadline = Date.now() + confirmTimeoutMs;
    for (;;) {
      if (await predicate()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, confirmPollMs));
    }
  };

  return {
    peerLabel,
    log,
    readPeerServer: async () => {
      const state = await readServerStateFromDir(peerHome);
      return state ? { port: state.port } : undefined;
    },
    readPeerIngest: async () => {
      const state = await readIngestStateFromDir(peerHome);
      return state ? { port: state.port, host: state.host } : undefined;
    },
    probeIngestListening: anyListening,
    writeShutdownRequest: async () => {
      const request: ShutdownRequest = { requestedBy, ts: Date.now() };
      const targetPath = join(peerHome, "shutdown-request.json");
      log(`writing request to: ${targetPath}`);
      await writeShutdownRequestToDir(peerHome, request);
      // Diagnostic: verify the file landed
      try {
        const { readFileSync } = await import("node:fs");
        const readBack = readFileSync(targetPath, "utf8");
        log(`write verified (${readBack.length} bytes): ${readBack.trim()}`);
      } catch (err: unknown) {
        log(`write verification FAILED: ${(err as Error).message}`);
      }
    },
    confirmDemoted: (target) =>
      pollUntil(async () => {
        // Only probe the published beacon host — NOT the full candidate list.
        // candidatesFor() includes "localhost" which on WSL resolves to WSL's
        // own 127.0.0.1, not Windows. A stale local ingest or WSL2 port-
        // forwarding (wslrelay) would make confirmDemoted think the peer is
        // still alive even after it exited. The published host (e.g.,
        // 172.30.192.1 on Windows' vEthernet adapter) is the authoritative
        // address that becomes unreachable once the peer ingest exits.
        const host = target.host ?? override ?? "localhost";
        if (await tcpConnectable(host, target.port)) return false;
        return true;
      }),
    clearPeerBeacons: async () => {
      for (const name of ["ingest.json", "ingest.pid", "server.json", "shutdown-request.json"]) {
        await rm(join(peerHome, name), { force: true }).catch(() => {});
      }
    },
    requestPeerShutdown: async (port) => {
      // Try each peer host candidate (localhost, then WSL gateway IP on NAT).
      const hosts = override ? [override] : peerHostCandidates(env);
      for (const host of hosts) {
        const baseUrl = `http://${host}:${port}/`;
        // First check if the server is even reachable.
        let reachable = false;
        try {
          const probe = await fetch(`${baseUrl}health`, { signal: AbortSignal.timeout(2000) });
          reachable = probe.ok;
        } catch {
          continue; // Not reachable on this host, try next.
        }
        if (!reachable) continue;

        // Server is reachable — request shutdown.
        try {
          const res = await fetch(`${baseUrl}__internal/shutdown`, {
            method: "POST",
            signal: AbortSignal.timeout(5000)
          });
          if (!res.ok) continue;
        } catch {
          continue;
        }
        // Wait for the server to stop responding.
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
          try {
            const probe = await fetch(`${baseUrl}health`, { signal: AbortSignal.timeout(500) });
            if (!probe.ok) return true;
          } catch {
            return true;
          }
        }
        return true;
      }
      // No host could reach the peer — treat as unreachable (stale beacon).
      return false;
    }
  };
}
