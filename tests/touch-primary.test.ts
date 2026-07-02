import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("useIsTouchPrimary", () => {
  test("subscribes to the shared touch-primary query via matchMedia", () => {
    const source = readFileSync("src/web/hooks/useIsTouchPrimary.ts", "utf8");

    expect(source).toContain('import { TOUCH_PRIMARY_QUERY } from "../mobile.js";');
    expect(source).toContain("window.matchMedia(TOUCH_PRIMARY_QUERY)");
    expect(source).toContain('mql.addEventListener("change", onChange)');
    expect(source).toContain('mql.removeEventListener("change", onChange)');
    expect(source).toContain("export function useIsTouchPrimary()");
  });
});
