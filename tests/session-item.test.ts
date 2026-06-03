import { describe, expect, test } from "bun:test";
import { sessionDisplayTitle } from "../src/web/components/SessionItem.js";

describe("sessionDisplayTitle", () => {
  test("uses the custom session name when present", () => {
    expect(sessionDisplayTitle({ name: "API server", displayCommand: "bun run server" })).toBe("API server");
  });

  test("falls back to displayCommand when the custom name is missing", () => {
    expect(sessionDisplayTitle({ displayCommand: "bun test tests/config.test.ts" })).toBe(
      "bun test tests/config.test.ts"
    );
  });

  test("falls back to displayCommand when the custom name is an empty string", () => {
    expect(sessionDisplayTitle({ name: "", displayCommand: "npm run dev" })).toBe("npm run dev");
  });
});
