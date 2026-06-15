import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceFileAtomic } from "../src/update/swap.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "climon-swap-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("replaceFileAtomic", () => {
  test("replaces an existing file's contents", () => {
    writeFileSync(join(dir, "climon"), "old");
    const result = replaceFileAtomic(dir, "climon", Buffer.from("new"));
    expect(result.applied).toBe(true);
    expect(readFileSync(join(dir, "climon"), "utf8")).toBe("new");
  });

  test("creates the file when it does not exist", () => {
    const result = replaceFileAtomic(dir, "climon-beta", Buffer.from("data"));
    expect(result.applied).toBe(true);
    expect(readFileSync(join(dir, "climon-beta"), "utf8")).toBe("data");
  });

  test("does not leave a temp file behind on success", () => {
    replaceFileAtomic(dir, "climon", Buffer.from("x"));
    const leftovers = require("node:fs")
      .readdirSync(dir)
      .filter((f: string) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  test("on Unix, replacing a file held open by a reader still succeeds", () => {
    if (process.platform === "win32") return;
    writeFileSync(join(dir, "climon"), "old");
    const fd = openSync(join(dir, "climon"), "r");
    try {
      const result = replaceFileAtomic(dir, "climon", Buffer.from("new"));
      expect(result.applied).toBe(true);
      expect(readFileSync(join(dir, "climon"), "utf8")).toBe("new");
    } finally {
      closeSync(fd);
    }
  });

  test("on Unix, the swapped-in file is executable", () => {
    if (process.platform === "win32") return;
    const fs = require("node:fs");
    fs.writeFileSync(join(dir, "climon"), "old", { mode: 0o755 });
    replaceFileAtomic(dir, "climon", Buffer.from("new"));
    expect(fs.statSync(join(dir, "climon")).mode & 0o111).not.toBe(0);
  });

  test("on Unix, a newly created binary is executable", () => {
    if (process.platform === "win32") return;
    const fs = require("node:fs");
    replaceFileAtomic(dir, "climon-beta", Buffer.from("data"));
    expect(fs.statSync(join(dir, "climon-beta")).mode & 0o111).not.toBe(0);
  });
});
