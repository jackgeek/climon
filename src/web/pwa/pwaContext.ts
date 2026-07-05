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
  /** The dashboard origin (e.g. `https://abc-8080.usw2.devtunnels.ms`). */
  origin: string;
  /** Navigates the current window to `url` in place. */
  navigate: (url: string) => void;
}

/**
 * Recovers an expired dev-tunnel sign-in with a full top-level navigation to the
 * dashboard origin. The service worker never intercepts navigations, so the
 * browser follows the cross-origin dev-tunnel → Microsoft sign-in redirect
 * natively and lands the fresh `*.devtunnels.ms` cookie in the current context.
 *
 * Note: an installed iOS home-screen PWA runs as a standalone WKWebView that
 * blocks script-initiated cross-origin navigations, so this in-app button cannot
 * refresh the cookie there — the reliable path on iOS is to relaunch the app,
 * whose launch navigation is allowed to follow the redirect. This button remains
 * effective in a normal browser tab.
 */
export function reauthenticateTunnel(env: TunnelReauthEnv): void {
  env.navigate(`${env.origin}/`);
}
