import { useEffect, useState } from "react";
import { MOBILE_MEDIA_QUERY } from "../mobile.js";

/**
 * Tracks whether the viewport is at or below the mobile breakpoint. Owns the
 * `matchMedia` subscription so the breakpoint lives in one place
 * (`mobile.ts`). Mirrors the `matchMedia` hook pattern in
 * `useAnimatedListReorder.ts`.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_MEDIA_QUERY).matches
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = (e: MediaQueryListEvent): void => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
