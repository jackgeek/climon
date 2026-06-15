import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Writable } from "node:stream";
import { getLogger, initLogger, resetLoggerForTests } from "../src/logging/logger.js";

async function makeTestHome(): Promise<string> {
  const base = join(process.cwd(), ".copilot-tmp");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "logger-iid-"));
}

function captureStream(lines: string[]): Writable {
  return new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
}

afterEach(() => {
  resetLoggerForTests();
});

describe("logger installId base", () => {
  test("installId is attached to emitted records when provided", async () => {
    const home = await makeTestHome();
    try {
      const lines: string[] = [];
      initLogger("server", {
        level: "info",
        env: { CLIMON_HOME: home } as NodeJS.ProcessEnv,
        installId: "11111111-2222-4333-8444-555555555555",
        extraStreams: [{ stream: captureStream(lines), level: "info" }],
      });
      getLogger().info("hello");
      const record = JSON.parse(lines.join("").trim().split("\n").pop() as string);
      expect(record.installId).toBe("11111111-2222-4333-8444-555555555555");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("installId is omitted when not provided", async () => {
    const home = await makeTestHome();
    try {
      const lines: string[] = [];
      initLogger("server", {
        level: "info",
        env: { CLIMON_HOME: home } as NodeJS.ProcessEnv,
        extraStreams: [{ stream: captureStream(lines), level: "info" }],
      });
      getLogger().info("hello");
      const record = JSON.parse(lines.join("").trim().split("\n").pop() as string);
      expect("installId" in record).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
