import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadToFile } from "../src/update/download.js";

let dir: string;
let server: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "climon-dl-"));
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/ok") {
        return new Response("payload-bytes");
      }
      return new Response("nope", { status: 404 });
    },
  });
});

afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("downloadToFile", () => {
  test("writes the body to disk and returns bytes", async () => {
    const dest = join(dir, "out.bin");
    const bytes = await downloadToFile(`http://localhost:${server.port}/ok`, dest);
    expect(new TextDecoder().decode(bytes)).toBe("payload-bytes");
    expect(readFileSync(dest, "utf8")).toBe("payload-bytes");
  });

  test("throws on a non-2xx response", async () => {
    const dest = join(dir, "missing.bin");
    await expect(
      downloadToFile(`http://localhost:${server.port}/missing`, dest)
    ).rejects.toThrow();
  });
});
