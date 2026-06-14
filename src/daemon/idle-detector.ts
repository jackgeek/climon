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

  /**
   * Re-baselines the tracked fingerprint after a viewer resize reflows the
   * screen. A resize is driven by a browser viewer attaching/resizing, not by
   * the program producing output, so it must not be treated as activity:
   * `flagged` and the idle countdown (`lastChangeAt`) are preserved. The next
   * `update` with the reflowed fingerprint then sees no change, keeping a
   * still-idle session flagged. No-op when idle detection is disabled or before
   * the first `update` has seeded a baseline.
   */
  absorbResize(fingerprint: string): void {
    if (this.idleMs <= 0 || this.lastFingerprint === undefined) {
      return;
    }
    this.lastFingerprint = fingerprint;
  }

}
