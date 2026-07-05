import { isDevTunnelHost } from "../api.js";
import { REAUTH_PARAM } from "./swCache.js";

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
 * Builds the URL used to re-run the dev-tunnel sign-in. It targets the origin
 * root with the `reauth` marker and deliberately omits the
 * `X-Tunnel-Skip-AntiPhishing-Page` param, so the relay serves its renderable
 * interactive sign-in / anti-phishing page (not the blank programmatic response
 * that a standalone iOS PWA downloaded as an "empty file").
 */
export function buildTunnelReauthUrl(origin: string): string {
  return `${origin}/?${REAUTH_PARAM}=1`;
}

/**
 * Recovers an expired dev-tunnel sign-in with a top-level navigation inside the
 * current window. On iOS a home-screen PWA has a cookie jar isolated from
 * Safari, so the sign-in must complete inside the PWA's own window for the
 * resulting `*.devtunnels.ms` cookie to be usable; opening Safari can never
 * refresh it. The service worker passes the `reauth`-marked navigation through
 * so the browser follows the cross-origin Microsoft redirect natively.
 */
export function reauthenticateTunnel(env: TunnelReauthEnv): void {
  env.navigate(buildTunnelReauthUrl(env.origin));
}
