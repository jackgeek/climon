import { afterEach, describe, expect, test } from "bun:test";
import { fetchHealth } from "../src/web/api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchHealth", () => {
  test("parses remotesEnabled from the health response", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(JSON.stringify({ version: "1.2.3", remotesEnabled: true }), {
          headers: { "content-type": "application/json" }
        }),
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch;

    await expect(fetchHealth()).resolves.toEqual({
      version: "1.2.3",
      remotesEnabled: true
    });
  });
});
