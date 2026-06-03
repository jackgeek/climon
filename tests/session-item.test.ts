import { describe, expect, test } from "bun:test";
import { sessionAccessibleLabel, sessionDisplayTitle } from "../src/web/components/SessionItem.js";

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

describe("sessionAccessibleLabel", () => {
  test("uses the visible title in expanded mode", () => {
    expect(
      sessionAccessibleLabel(
        { name: "API server", displayCommand: "bun run server", status: "running" },
        false
      )
    ).toBeUndefined();
  });

  test("includes the session title and full status in compact mode", () => {
    expect(
      sessionAccessibleLabel(
        { name: "API server", displayCommand: "bun run server", status: "needs-attention" },
        true
      )
    ).toBe("API server, needs attention");
  });

  test("falls back to displayCommand for compact labels when no custom name is present", () => {
    expect(
      sessionAccessibleLabel(
        { displayCommand: "bun test tests/config.test.ts", status: "completed" },
        true
      )
    ).toBe("bun test tests/config.test.ts, completed");
  });
});
