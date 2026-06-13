export const MUX_IDLE_TIMEOUT_FACTOR = 3;

export function muxIdleTimeoutMs(keepAliveMs: number): number {
  if (!Number.isFinite(keepAliveMs) || keepAliveMs <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(keepAliveMs * MUX_IDLE_TIMEOUT_FACTOR));
}
