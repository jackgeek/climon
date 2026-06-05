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
  private acknowledgedFingerprint: string | undefined;
  private inputSuppressedFingerprint: string | undefined;
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
      const wasAcknowledged = this.acknowledgedFingerprint !== undefined;
      this.lastFingerprint = fingerprint;
      this.lastChangeAt = now;
      this.acknowledgedFingerprint = undefined;
      this.inputSuppressedFingerprint = undefined;
      if (this.flagged || wasAcknowledged) {
        this.flagged = false;
        return { needsAttention: false };
      }
      return undefined;
    }

    if (fingerprint === this.acknowledgedFingerprint || fingerprint === this.inputSuppressedFingerprint) {
      return undefined;
    }

    if (!this.flagged && now - this.lastChangeAt >= this.idleMs) {
      this.flagged = true;
      return { needsAttention: true, reason: `Screen idle for ${this.idleMs / 1000}s` };
    }

    return undefined;
  }

  acknowledge(fingerprint: string, now: number): void {
    this.lastFingerprint = fingerprint;
    this.lastChangeAt = now;
    this.flagged = false;
    this.acknowledgedFingerprint = fingerprint;
    this.inputSuppressedFingerprint = undefined;
  }

  /**
   * Absorbs the screen produced by user input (the echoed keystrokes and any
   * immediate output) so a session the user is actively driving is not treated
   * as idle. The settled screen is suppressed exactly like an acknowledged
   * screen — a silently-running command (e.g. `sleep 30`) holds that screen and
   * never re-flags — but the suppression is recorded separately because the
   * session stays `running` rather than `acknowledged`. When the program later
   * emits genuinely new output the screen changes, suppression clears, and a
   * fresh idle window can flag `needs-attention` again.
   *
   * Returns `{ needsAttention: false }` only when there is an active state to
   * clear (a flagged or acknowledged session becomes running); plain running
   * sessions and repeated input settles emit nothing to avoid redundant writes.
   */
  settleInput(fingerprint: string, now: number): IdleTransition | undefined {
    if (this.idleMs <= 0) {
      return undefined;
    }
    const wasActive = this.flagged || this.acknowledgedFingerprint !== undefined;
    this.lastFingerprint = fingerprint;
    this.lastChangeAt = now;
    this.acknowledgedFingerprint = undefined;
    this.inputSuppressedFingerprint = fingerprint;
    this.flagged = false;
    return wasActive ? { needsAttention: false } : undefined;
  }

  /**
   * Re-bases the tracked fingerprints onto a new screen geometry without
   * treating the change as meaningful activity. Callers invoke this after a
   * terminal resize so the resulting reflow is not mistaken for a content
   * change: it must neither clear an acknowledged, input-suppressed, or flagged
   * state nor reset the idle timer. The current state and idle clock are
   * preserved; only the stored fingerprints move to the post-resize screen. A
   * no-op before the first `update` (nothing has been seeded yet) and when
   * detection is disabled.
   */
  rebase(fingerprint: string): void {
    if (this.lastFingerprint !== undefined) {
      this.lastFingerprint = fingerprint;
    }
    if (this.acknowledgedFingerprint !== undefined) {
      this.acknowledgedFingerprint = fingerprint;
    }
    if (this.inputSuppressedFingerprint !== undefined) {
      this.inputSuppressedFingerprint = fingerprint;
    }
  }
}
