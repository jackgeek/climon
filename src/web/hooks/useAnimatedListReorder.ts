import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefCallback } from "react";

const ANIMATION_MS = 180;

export interface AnimatedListReorderApi {
  registerItem: (id: string) => RefCallback<HTMLElement>;
  getItemStyle: (id: string) => CSSProperties;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// null = idle; non-null Record = animating (non-zero value = phase 1 snap, zero value = phase 2 ease)
type OffsetState = Record<string, number> | null;

export function useAnimatedListReorder(ids: string[]): AnimatedListReorderApi {
  const elementsRef = useRef<Record<string, HTMLElement | undefined>>({});
  const previousTopsRef = useRef<Record<string, number>>({});
  const initializedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cached stable ref callbacks per id so React never sees a new function object on re-render.
  const refCallbacksRef = useRef<Record<string, RefCallback<HTMLElement>>>({});
  const [offsets, setOffsets] = useState<OffsetState>(null);
  const key = ids.join("\u001f");

  useLayoutEffect(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    const nextTops: Record<string, number> = {};
    for (const id of ids) {
      const element = elementsRef.current[id];
      if (element) {
        nextTops[id] = element.getBoundingClientRect().top;
      }
    }

    if (!initializedRef.current || prefersReducedMotion()) {
      initializedRef.current = true;
      previousTopsRef.current = nextTops;
      setOffsets(null);
      return;
    }

    const nextOffsets: Record<string, number> = {};
    for (const id of ids) {
      const previousTop = previousTopsRef.current[id];
      const nextTop = nextTops[id];
      if (previousTop === undefined || nextTop === undefined) {
        continue;
      }
      const offset = previousTop - nextTop;
      if (offset !== 0) {
        nextOffsets[id] = offset;
      }
    }

    previousTopsRef.current = nextTops;

    if (Object.keys(nextOffsets).length === 0) {
      setOffsets(null);
      return;
    }

    // Phase 1: snap items to their previous visual positions.
    setOffsets(nextOffsets);

    // Phase 2: one frame later, move items to top: 0 so the CSS transition animates them.
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const zeroOffsets: Record<string, number> = {};
      for (const id of Object.keys(nextOffsets)) {
        zeroOffsets[id] = 0;
      }
      setOffsets(zeroOffsets);

      // After the animation completes, return items to the idle (no-style) state.
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        setOffsets(null);
      }, ANIMATION_MS);
    });

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [key]);

  const registerItem = useCallback((id: string): RefCallback<HTMLElement> => {
    if (!(id in refCallbacksRef.current)) {
      refCallbacksRef.current[id] = (element) => {
        if (element) {
          elementsRef.current[id] = element;
        } else {
          delete elementsRef.current[id];
          delete previousTopsRef.current[id];
        }
      };
    }
    return refCallbacksRef.current[id]!;
  }, []);

  const getItemStyle = useCallback(
    (id: string): CSSProperties => {
      if (offsets === null || !(id in offsets)) {
        return {};
      }
      const offset = offsets[id]!;
      if (offset !== 0) {
        return { position: "relative", top: offset, transition: "top 0ms" };
      }
      return { position: "relative", top: 0, transition: `top ${ANIMATION_MS}ms ease` };
    },
    [offsets]
  );

  return useMemo(
    () => ({ registerItem, getItemStyle }),
    [getItemStyle, registerItem]
  );
}
