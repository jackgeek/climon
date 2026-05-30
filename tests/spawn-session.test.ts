import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnHeadlessSession } from "../src/client/spawn-session.js";

const home = join(process.cwd(), `.climon-spawn-session-${process.pid}`);
const env = { ...process.env, CLIMON_HOME: home };

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("spawnHeadlessSession", () => {
  test("writes metadata with the given cwd and command, returns an id", async () => {
    const id = await spawnHeadlessSession(["sleep", "30"], "/tmp", { cols: 100, rows: 40 }, env);
    expect(id).toMatch(/^[a-z0-9]+-[a-f0-9]{6}$/);
    const metaPath = join(home, "sessions", `${id}.json`);
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as {
      cwd: string;
      command: string[];
      cols: number;
      rows: number;
    };
    expect(meta.cwd).toBe("/tmp");
    expect(meta.command).toEqual(["sleep", "30"]);
    expect(meta.cols).toBe(100);
    expect(meta.rows).toBe(40);
  });
});
