import { isDevTunnelHost } from "../api.js";

export function computeIsTunnelOrigin(hostname: string, protocol: string): boolean {
  return isDevTunnelHost(hostname) && protocol === "https:";
}

export function computeIsStandalone(
  displayModeStandalone: boolean,
  iosStandalone: boolean | undefined,
): boolean {
  return displayModeStandalone || iosStandalone === true;
}

export function canInstallPwa(state: { isTunnelOrigin: boolean; isStandalone: boolean }): boolean {
  return state.isTunnelOrigin && !state.isStandalone;
}

export function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

export function readIsTunnelOrigin(): boolean {
  if (typeof location === "undefined") return false;
  return computeIsTunnelOrigin(location.hostname, location.protocol);
}

export function readIsStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const displayMode = typeof window.matchMedia === "function"
    ? window.matchMedia("(display-mode: standalone)").matches
    : false;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return computeIsStandalone(displayMode, iosStandalone);
}

export interface TunnelReauthEnv {
  /** True when running as an installed PWA (home-screen / display-mode standalone). */
  isStandalone: boolean;
  /** The current dashboard URL to re-open for the dev-tunnel sign-in. */
  href: string;
  /** Opens `url` in the system browser (a real tab), escaping the PWA window. */
  openBrowser: (url: string) => void;
  /** Navigates the current window to `url` in place. */
  navigate: (url: string) => void;
}

/**
 * Recovers an expired dev-tunnel sign-in. A standalone PWA cannot complete the
 * dev tunnels multi-step, cross-origin auth flow inside its own window: the
 * redirect chain ends in an empty-file download instead of the Microsoft
 * sign-in page. So it re-opens the tunnel URL in the system browser (a real
 * tab), where the auth flow works and the resulting `*.devtunnels.ms` cookie is
 * shared back with the PWA, letting its live connection reconnect on return.
 * In a normal browser tab, a same-URL reload performs the reauth in place.
 */
export function reauthenticateTunnel(env: TunnelReauthEnv): void {
  if (env.isStandalone) {
    env.openBrowser(env.href);
    return;
  }
  env.navigate(env.href);
}
