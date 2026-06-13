import { describe, expect, test } from "bun:test";
import { renderManifest } from "../src/server/assets.js";

describe("renderManifest", () => {
  test("declares a standalone PWA with icons", () => {
    const manifest = JSON.parse(renderManifest()) as {
      display: string;
      start_url: string;
      icons: { src: string; sizes: string; purpose?: string }[];
      theme_color: string;
      background_color: string;
    };
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.background_color).toBe("#ffffff");
    const srcs = manifest.icons.map((i) => i.src);
    expect(srcs).toContain("/assets/icon-192.png");
    expect(srcs).toContain("/assets/icon-512.png");
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });
});
