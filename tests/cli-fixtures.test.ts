import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { helpText } from "../src/cli/args.js";
import { VERSION } from "../src/version.js";

const fixturesDir = join(import.meta.dir, "..", "fixtures", "cli");

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

describe("cli golden fixtures", () => {
  test("helpText matches fixtures/cli/help.txt byte-for-byte", () => {
    expect(helpText).toBe(fixture("help.txt"));
  });

  test("--version output matches fixtures/cli/version.txt", () => {
    expect(`climon v${VERSION}\n`).toBe(fixture("version.txt"));
  });

  test("help fixture embeds the package.json version on line 1", () => {
    const firstLine = fixture("help.txt").split("\n")[0];
    expect(firstLine).toBe(`climon v${VERSION} — web-based monitor for interactive CLI sessions`);
  });
});
