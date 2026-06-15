import { describe, expect, test } from "bun:test";
import {
  compareSemver,
  fetchManifest,
  isNewer,
  type Manifest,
} from "../src/update/manifest.js";

describe("compareSemver", () => {
  test("orders by major, minor, patch", () => {
    expect(compareSemver("0.13.0", "0.12.9")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("0.12.1", "0.12.10")).toBeLessThan(0);
  });

  test("tolerates a leading v", () => {
    expect(compareSemver("v0.13.0", "0.13.0")).toBe(0);
  });
});

describe("isNewer", () => {
  test("true when manifest version exceeds current", () => {
    const m: Manifest = {
      version: "0.13.0",
      artifacts: { "linux-x64": { url: "u", sig: "s" } },
    };
    expect(isNewer(m, "0.12.1")).toBe(true);
    expect(isNewer(m, "0.13.0")).toBe(false);
    expect(isNewer(m, "0.14.0")).toBe(false);
  });
});

describe("fetchManifest", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  async function withFetch<T>(
    impl: typeof fetch,
    fn: () => Promise<T>
  ): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await fn();
    } finally {
      globalThis.fetch = original;
    }
  }

  test("returns a well-formed manifest", async () => {
    const manifest = {
      version: "0.13.0",
      artifacts: { "linux-x64": { url: "u", sig: "s" } },
    };
    const result = await withFetch(
      (async () => jsonResponse(manifest)) as unknown as typeof fetch,
      () => fetchManifest("https://example.test/manifest.json")
    );
    expect(result).toEqual(manifest);
  });

  test("rejects non-ok responses", async () => {
    await expect(
      withFetch(
        (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
        () => fetchManifest("https://example.test/manifest.json")
      )
    ).rejects.toThrow("HTTP 404");
  });

  test.each([
    ["literal null", null],
    ["array artifacts", { version: "1.0.0", artifacts: [] }],
    ["null artifacts", { version: "1.0.0", artifacts: null }],
    ["missing version", { artifacts: {} }],
  ])("rejects malformed manifest (%s)", async (_label, body) => {
    await expect(
      withFetch(
        (async () => jsonResponse(body)) as unknown as typeof fetch,
        () => fetchManifest("https://example.test/manifest.json")
      )
    ).rejects.toThrow("Malformed manifest");
  });
});
