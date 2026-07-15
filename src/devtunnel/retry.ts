import type { DevtunnelFailure, DevtunnelRetryState } from "./types.js";

export class DevtunnelRetryController {
  private attempt = 0;
  private paused = false;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
    private readonly baseMs = 1000,
    private readonly capMs = 30000
  ) {}

  fail(failure: DevtunnelFailure): DevtunnelRetryState {
    if (failure.retryClass !== "transient") {
      this.paused = true;
      return { attempt: this.attempt, paused: this.paused };
    }
    this.attempt += 1;
    const raw = Math.min(this.capMs, this.baseMs * 2 ** (this.attempt - 1));
    const jittered = Math.round(raw * (0.8 + this.random() * 0.4));
    const delay = failure.retryAfterMs ? Math.max(jittered, failure.retryAfterMs) : jittered;
    return {
      attempt: this.attempt,
      paused: false,
      nextRetryAt: new Date(this.now() + delay).toISOString()
    };
  }

  success(): DevtunnelRetryState {
    this.attempt = 0;
    this.paused = false;
    return { attempt: this.attempt, paused: this.paused };
  }

  resume(): DevtunnelRetryState {
    this.paused = false;
    return { attempt: this.attempt, paused: this.paused };
  }
}
