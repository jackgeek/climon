import { describe, expect, test } from "bun:test";
import { remotesMenuLabel } from "../src/web/components/Sidebar.js";

describe("Sidebar menu", () => {
  test("labels remotes as experimental", () => {
    expect(remotesMenuLabel).toBe("Remotes (experimental)…");
  });
});
