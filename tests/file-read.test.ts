import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfinedFile } from "../src/server/file-read.js";

let root = "";
let cwd = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "climon-fileread-"));
  cwd = join(root, "project");
  await mkdir(join(cwd, "sub"), { recursive: true });
  await writeFile(join(cwd, "readme.txt"), "hello world\nsecond line\n");
  await writeFile(join(cwd, "sub", "nested.txt"), "nested\n");
  await writeFile(join(root, "secret.txt"), "TOP SECRET\n");
  await writeFile(join(cwd, "binary.bin"), Buffer.from([0x41, 0x00, 0x42]));
  await symlink(join(root, "secret.txt"), join(cwd, "escape-link"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("readConfinedFile", () => {
  test("reads a regular file inside cwd", async () => {
    const r = await readConfinedFile(cwd, "readme.txt", 1024);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.content).toBe("hello world\nsecond line\n");
  });

  test("reads a cwd-relative nested file", async () => {
    const r = await readConfinedFile(cwd, "sub/nested.txt", 1024);
    expect(r.status).toBe("ok");
  });

  test("refuses ../ escape", async () => {
    const r = await readConfinedFile(cwd, "../secret.txt", 1024);
    expect(r.status).toBe("refused");
  });

  test("refuses an absolute path outside cwd", async () => {
    const r = await readConfinedFile(cwd, join(root, "secret.txt"), 1024);
    expect(r.status).toBe("refused");
  });

  test("refuses a symlink that escapes cwd", async () => {
    const r = await readConfinedFile(cwd, "escape-link", 1024);
    expect(r.status).toBe("refused");
  });

  test("reports not-found for a missing file", async () => {
    const r = await readConfinedFile(cwd, "nope.txt", 1024);
    expect(r.status).toBe("not-found");
  });

  test("reports too-large when over the cap", async () => {
    const r = await readConfinedFile(cwd, "readme.txt", 4);
    expect(r.status).toBe("too-large");
  });

  test("reports binary for files containing NUL bytes", async () => {
    const r = await readConfinedFile(cwd, "binary.bin", 1024);
    expect(r.status).toBe("binary");
  });
});
