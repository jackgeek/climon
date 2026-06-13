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
