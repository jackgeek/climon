/**
 * In-memory registry of push-subscription endpoints that are currently in the
 * foreground. A foreground endpoint's OS push is suppressed by the push service
 * (the in-app toast alerts instead). Entries expire after `ttlMs` so a device
 * that goes away without reporting "hidden" resumes receiving pushes. DOM-free
 * and clock-injectable so it is unit-testable, matching the other pure helpers
 * in this directory.
 */
export interface PresenceRegistry {
  /** Mark an endpoint foreground (or refresh its heartbeat), extending its TTL. */
  markForeground(endpoint: string): void;
  /** Mark an endpoint backgrounded immediately (clears foreground). */
  markBackground(endpoint: string): void;
  /** Whether the endpoint is currently foreground (and not expired). */
  isForeground(endpoint: string): boolean;
}

export interface PresenceRegistryOptions {
  /** Clock source in epoch ms. Defaults to `Date.now`. */
  now?: () => number;
  /** How long a foreground report stays valid without a refresh. Default 30s. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 30_000;

export function createPresenceRegistry(options: PresenceRegistryOptions = {}): PresenceRegistry {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const expiries = new Map<string, number>();

  return {
    markForeground(endpoint: string): void {
      expiries.set(endpoint, now() + ttlMs);
    },
    markBackground(endpoint: string): void {
      expiries.delete(endpoint);
    },
    isForeground(endpoint: string): boolean {
      const expiry = expiries.get(endpoint);
      if (expiry === undefined) {
        return false;
      }
      if (now() >= expiry) {
        expiries.delete(endpoint);
        return false;
      }
      return true;
    }
  };
}
