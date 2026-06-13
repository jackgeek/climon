import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateSessionId } from "../src/session-id.js";

const home = join(process.cwd(), `.climon-session-id-${process.pid}`);
const env: NodeJS.ProcessEnv = { ...process.env, CLIMON_HOME: home };

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("generateSessionId", () => {
  test("returns a lowercase adjective-noun-verb id", async () => {
    const id = await generateSessionId(env);
    expect(id).toMatch(/^[a-z]+(-[a-z]+){2}$/);
  });

  test("re-rolls when the candidate id already has a metadata file", async () => {
    const sessionsDir = join(home, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, "taken-words-here.json"), "{}");

    const candidates = ["taken-words-here", "free-words-here"];
    let i = 0;
    const id = await generateSessionId(env, () => candidates[i++]!);

    expect(id).toBe("free-words-here");
  });
});
