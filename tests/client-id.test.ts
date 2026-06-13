import { describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import { join } from "node:path";
import { sanitizeClientId, resolveClientId } from "../src/remote/client-id.js";

describe("sanitizeClientId", () => {
  test("keeps a valid hostname unchanged", () => {
    expect(sanitizeClientId("my-devbox")).toBe("my-devbox");
  });

  test("replaces disallowed characters with hyphens and trims", () => {
    expect(sanitizeClientId("My Box!!")).toBe("My-Box");
  });

  test("truncates to 64 characters", () => {
    expect(sanitizeClientId("a".repeat(100)).length).toBe(64);
  });

  test("falls back to a dev- id when nothing valid remains", () => {
    expect(sanitizeClientId("!!!")).toMatch(/^dev-[0-9a-f]{10}$/);
  });
});

describe("resolveClientId", () => {
  test("defaults to the sanitised hostname when unconfigured", () => {
    const isolatedRoot = join(process.cwd(), ".climon-clientid-test", String(process.pid));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLIMON_HOME: isolatedRoot
    };
    expect(resolveClientId(env, isolatedRoot)).toBe(sanitizeClientId(hostname()));
  });
});
