import { useEffect, useState } from "react";
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { fetchDashboardTunnelStatus } from "../api.js";
import { readIsTunnelOrigin } from "../pwa/pwaContext.js";
import { formatExpiryCountdown } from "../tunnelExpiry.js";

const EXPIRY_REFETCH_MS = 5 * 60 * 1000;
const TICK_MS = 1000;

const useStyles = makeStyles({
  base: {
    padding: "12px 16px",
    textAlign: "center",
    fontWeight: tokens.fontWeightSemibold
  },
  // Desktop: overlay pinned to the very top of the viewport.
  fixed: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000
  },
  // Mobile: an in-flow block inside the sidebar, below the climon header and
  // above the session list, so it never covers the header or the terminal.
  inline: {
    flex: "0 0 auto",
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`
  },
  info: {
    // Fixed dark green so white text stays readable in both themes: the Fluent
    // dark-green token resolves to a light green (#9ad29a) in light mode.
    backgroundColor: "#0f5132",
    color: tokens.colorNeutralForegroundOnBrand
  },
  warn: {
    backgroundColor: tokens.colorPaletteYellowBackground3,
    // Fixed dark text: colorPaletteYellowBackground3 is a bright yellow in both
    // themes, so a theme-adaptive neutral foreground would be unreadable in dark mode.
    color: "#1a1a1a"
  },
  expired: {
    backgroundColor: tokens.colorPaletteRedBackground3,
    color: tokens.colorNeutralForegroundOnBrand
  }
});

/**
 * Banner that counts down to the dev tunnel's absolute expiry. Renders only when
 * the dashboard is opened through the tunnel link (a `*.devtunnels.ms` HTTPS
 * origin) and an expiry is known. Re-fetches the expiry every 5 minutes to follow
 * the rolling extension, and re-renders every second for a live countdown.
 *
 * `variant` controls placement: `"fixed"` (default) pins it to the top of the
 * viewport on desktop; `"inline"` renders it as an in-flow block (used inside the
 * sidebar on mobile, below the header and above the session list).
 */
export function TunnelExpiryBanner({ variant = "fixed" }: { variant?: "fixed" | "inline" } = {}) {
  const styles = useStyles();
  const isTunnelOrigin = readIsTunnelOrigin();
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isTunnelOrigin) return;
    let cancelled = false;
    const load = () => {
      void fetchDashboardTunnelStatus()
        .then((status) => {
          if (!cancelled) setExpiresAt(status.expiresAt ?? null);
        })
        .catch(() => {
          if (!cancelled) setExpiresAt(null);
        });
    };
    load();
    const timer = setInterval(load, EXPIRY_REFETCH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isTunnelOrigin]);

  useEffect(() => {
    if (!isTunnelOrigin || !expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [isTunnelOrigin, expiresAt]);

  if (!isTunnelOrigin || !expiresAt) return null;
  const msRemaining = Date.parse(expiresAt) - now;
  if (Number.isNaN(msRemaining)) return null;

  const { text, level } = formatExpiryCountdown(msRemaining);
  return (
    <div
      role="timer"
      aria-live="off"
      className={mergeClasses(styles.base, variant === "inline" ? styles.inline : styles.fixed, styles[level])}
    >
      {text}
    </div>
  );
}
