import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstallId, getInstallId } from "../src/setup/install-id.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "climon-"));
  env = { ...process.env, CLIMON_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("install id", () => {
  test("getInstallId is undefined before setup", () => {
    expect(getInstallId(env)).toBeUndefined();
  });

  test("ensureInstallId generates and persists a uuid", () => {
    const id = ensureInstallId(env);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(getInstallId(env)).toBe(id);
  });

  test("ensureInstallId is idempotent", () => {
    const first = ensureInstallId(env);
    const second = ensureInstallId(env);
    expect(second).toBe(first);
  });
});
