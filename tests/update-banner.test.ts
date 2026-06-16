import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeShowUpdateBanner } from "../src/update/launch-hooks.js";
import { setAvailableVersion } from "../src/update/state.js";
import { VERSION } from "../src/version.js";

let home: string;
let env: NodeJS.ProcessEnv;
let captured: string;
let restore: () => void;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "climon-banner-"));
  env = { ...process.env, CLIMON_HOME: home };
  captured = "";
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  restore = () => {
    process.stderr.write = original;
  };
});

afterEach(() => {
  restore();
  rmSync(home, { recursive: true, force: true });
});

describe("maybeShowUpdateBanner", () => {
  test("shows the banner when the cached version is newer than the running one", async () => {
    setAvailableVersion("999.0.0", env);
    await maybeShowUpdateBanner(env);
    expect(captured).toContain("999.0.0");
  });

  test("does not show the banner when the cached version equals the running one", async () => {
    setAvailableVersion(VERSION, env);
    await maybeShowUpdateBanner(env);
    expect(captured).toBe("");
  });

  test("does not show the banner with no cached version", async () => {
    await maybeShowUpdateBanner(env);
    expect(captured).toBe("");
  });
});
