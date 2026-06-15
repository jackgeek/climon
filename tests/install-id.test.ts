import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ensureInstallId, getInstallId, getInstallIdPath } from "../src/install-id.js";

async function makeTestHome(): Promise<string> {
  const base = join(process.cwd(), ".copilot-tmp");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "install-id-"));
}

function envFor(home: string): NodeJS.ProcessEnv {
  return { CLIMON_HOME: home } as NodeJS.ProcessEnv;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("install id", () => {
  test("path is install.json under CLIMON_HOME", async () => {
    const home = await makeTestHome();
    try {
      expect(getInstallIdPath(envFor(home))).toBe(join(home, "install.json"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("generates a uuid when absent and persists it", async () => {
    const home = await makeTestHome();
    try {
      const env = envFor(home);
      const id = await ensureInstallId(env);
      expect(id).toMatch(UUID_RE);
      const onDisk = JSON.parse(await readFile(getInstallIdPath(env), "utf8"));
      expect(onDisk.id).toBe(id);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("returns the same id on repeated calls (stable)", async () => {
    const home = await makeTestHome();
    try {
      const env = envFor(home);
      const first = await ensureInstallId(env);
      const second = await ensureInstallId(env);
      expect(second).toBe(first);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("persists across a simulated restart (fresh read)", async () => {
    const home = await makeTestHome();
    try {
      const env = envFor(home);
      const first = await ensureInstallId(env);
      // Simulate a new process: nothing cached, just read again.
      const second = await ensureInstallId(env);
      expect(getInstallId(env) === undefined).toBe(false);
      expect(second).toBe(first);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("regenerates when the file is corrupt", async () => {
    const home = await makeTestHome();
    try {
      const env = envFor(home);
      await mkdir(home, { recursive: true });
      await writeFile(getInstallIdPath(env), "not json{", "utf8");
      const id = await ensureInstallId(env);
      expect(id).toMatch(UUID_RE);
      const onDisk = JSON.parse(await readFile(getInstallIdPath(env), "utf8"));
      expect(onDisk.id).toBe(id);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("regenerates when the stored id is not a valid uuid", async () => {
    const home = await makeTestHome();
    try {
      const env = envFor(home);
      await mkdir(home, { recursive: true });
      await writeFile(getInstallIdPath(env), JSON.stringify({ id: "" }), "utf8");
      const id = await ensureInstallId(env);
      expect(id).toMatch(UUID_RE);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("concurrent ensure calls converge on a single id", async () => {
    const home = await makeTestHome();
    try {
      const env = envFor(home);
      const ids = await Promise.all(
        Array.from({ length: 8 }, () => ensureInstallId(env)),
      );
      const unique = new Set(ids);
      expect(unique.size).toBe(1);
      const onDisk = JSON.parse(await readFile(getInstallIdPath(env), "utf8"));
      expect(onDisk.id).toBe(ids[0]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("getInstallId returns undefined when absent, value when present", async () => {
    const home = await makeTestHome();
    try {
      const env = envFor(home);
      expect(getInstallId(env)).toBeUndefined();
      const id = await ensureInstallId(env);
      expect(getInstallId(env)).toBe(id);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
