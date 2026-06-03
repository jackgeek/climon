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

export function useAnimatedListReorder(ids: string[]): AnimatedListReorderApi {
  const elementsRef = useRef<Record<string, HTMLElement | undefined>>({});
  const previousTopsRef = useRef<Record<string, number>>({});
  const initializedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const key = ids.join("\u001f");

  useLayoutEffect(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
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
      setOffsets({});
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
    setOffsets(nextOffsets);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setOffsets({});
    });

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [key]);

  const registerItem = useCallback(
    (id: string): RefCallback<HTMLElement> =>
      (element) => {
        if (element) {
          elementsRef.current[id] = element;
        } else {
          delete elementsRef.current[id];
          delete previousTopsRef.current[id];
        }
      },
    []
  );

  const getItemStyle = useCallback(
    (id: string): CSSProperties => {
      const offset = offsets[id] ?? 0;
      return {
        position: "relative",
        top: offset,
        transition: offset === 0 ? `top ${ANIMATION_MS}ms ease` : "top 0ms"
      };
    },
    [offsets]
  );

  return useMemo(
    () => ({ registerItem, getItemStyle }),
    [getItemStyle, registerItem]
  );
}
