export type ExpiryLevel = "info" | "warn" | "expired";

export interface ExpiryCountdown {
  text: string;
  level: ExpiryLevel;
}

const HOUR_MS = 3_600_000;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Formats the milliseconds remaining until the dev tunnel expires into banner
 * text plus a severity level:
 * - `info`  (>= 1 hour): coarse `29d 23h 14m` / `5h 22m`, no seconds, no `0d`.
 * - `warn`  (0 < ms < 1 hour): `04m 32s`, minutes + seconds zero-padded.
 * - `expired` (ms <= 0): a fixed expired message.
 */
export function formatExpiryCountdown(msRemaining: number): ExpiryCountdown {
  if (msRemaining <= 0) {
    return { text: "Tunnel link expired", level: "expired" };
  }

  const totalSeconds = Math.floor(msRemaining / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (msRemaining >= HOUR_MS) {
    const parts = days > 0 ? [`${days}d`, `${hours}h`, `${minutes}m`] : [`${hours}h`, `${minutes}m`];
    return { text: `Tunnel link expires in ${parts.join(" ")}`, level: "info" };
  }

  return { text: `Tunnel link expires in ${pad(minutes)}m ${pad(seconds)}s`, level: "warn" };
}
