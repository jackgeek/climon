import { useEffect, useState } from "react";
import { TOUCH_PRIMARY_QUERY } from "../mobile.js";

/**
 * Tracks whether the device's primary pointer is coarse and cannot hover
 * (phones/tablets, including wide-viewport ones). Owns the `matchMedia`
 * subscription so the query lives in one place (`mobile.ts`). Mirrors the
 * `matchMedia` hook pattern in `useIsMobile.ts`.
 */
export function useIsTouchPrimary(): boolean {
  const [isTouchPrimary, setIsTouchPrimary] = useState(
    () => typeof window !== "undefined" && window.matchMedia(TOUCH_PRIMARY_QUERY).matches
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(TOUCH_PRIMARY_QUERY);
    const onChange = (e: MediaQueryListEvent): void => setIsTouchPrimary(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isTouchPrimary;
}
