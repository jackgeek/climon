import { describe, expect, test } from "bun:test";
import { MOBILE_MAX_WIDTH_PX, MOBILE_MEDIA_QUERY, MOBILE_MEDIA_QUERY_RULE } from "../src/web/mobile.js";

describe("mobile breakpoint", () => {
  test("derives the media query from the pixel constant", () => {
    expect(MOBILE_MAX_WIDTH_PX).toBe(768);
    expect(MOBILE_MEDIA_QUERY).toBe("(max-width: 768px)");
    expect(MOBILE_MEDIA_QUERY).toContain(String(MOBILE_MAX_WIDTH_PX));
  });

  test("exposes a @media-prefixed rule key for makeStyles", () => {
    expect(MOBILE_MEDIA_QUERY_RULE).toBe("@media (max-width: 768px)");
    expect(MOBILE_MEDIA_QUERY_RULE.startsWith("@media ")).toBe(true);
  });
});
