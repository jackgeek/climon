import { afterEach, describe, expect, test } from "bun:test";
import { fetchHealth } from "../src/web/api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchHealth", () => {
  test("parses remotesEnabled and features from the health response", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            version: "1.2.3",
            remotesEnabled: true,
            features: { sessionSpawning: { enabled: true, locked: false, status: "experimental" } }
          }),
          { headers: { "content-type": "application/json" } }
        ),
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch;

    await expect(fetchHealth()).resolves.toEqual({
      version: "1.2.3",
      remotesEnabled: true,
      features: { sessionSpawning: { enabled: true, locked: false, status: "experimental" } }
    });
  });

  test("defaults features to an empty object when absent", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(JSON.stringify({ version: "1.2.3", remotesEnabled: false }), {
          headers: { "content-type": "application/json" }
        }),
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch;

    await expect(fetchHealth()).resolves.toEqual({
      version: "1.2.3",
      remotesEnabled: false,
      features: {}
    });
  });
});
