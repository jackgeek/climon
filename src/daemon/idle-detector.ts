export interface IdleTransition {
  needsAttention: boolean;
  reason?: string;
}

/**
 * Tracks a stream of screen fingerprints over time and decides when a session
 * transitions into or out of the "needs attention" state. A session needs
 * attention when its fingerprint has not changed for `idleSeconds`. The detector
 * is pure (no timers, no I/O): callers supply the fingerprint and current time,
 * and it returns the transition to emit — or `undefined` when nothing changes.
 */
export class ScreenIdleDetector {
  private readonly idleMs: number;
  private lastFingerprint: string | undefined;
  private lastChangeAt = 0;
  private flagged = false;

  constructor(idleSeconds: number) {
    this.idleMs = idleSeconds * 1000;
  }

  update(fingerprint: string, now: number): IdleTransition | undefined {
    if (this.idleMs <= 0) {
      return undefined;
    }

    if (this.lastFingerprint === undefined) {
      this.lastFingerprint = fingerprint;
      this.lastChangeAt = now;
      return undefined;
    }

    if (fingerprint !== this.lastFingerprint) {
      this.lastFingerprint = fingerprint;
      this.lastChangeAt = now;
      if (this.flagged) {
        this.flagged = false;
        return { needsAttention: false };
      }
      return undefined;
    }

    if (!this.flagged && now - this.lastChangeAt >= this.idleMs) {
      this.flagged = true;
      return { needsAttention: true, reason: `Screen idle for ${this.idleMs / 1000}s` };
    }

    return undefined;
  }
}
