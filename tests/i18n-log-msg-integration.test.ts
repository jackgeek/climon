import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Writable } from "node:stream";
import { getLogger, initLogger, resetLoggerForTests } from "../src/logging/logger.js";
import { logMsg } from "../src/i18n/log-msg.js";
import type { Catalog } from "../src/i18n/types.js";

const CAT: Catalog = {
  "srv.probe": {
    id: "0000000b",
    t: "probing {url}health",
    hint: "health-probe diagnostic",
    params: { url: { redact: false } },
  },
};

async function makeTestHome(): Promise<string> {
  const base = join(process.cwd(), ".copilot-tmp");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "logmsg-integ-"));
}

function captureStream(lines: string[]): Writable {
  return new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
}

afterEach(() => resetLoggerForTests());

describe("logMsg integration with the real logger", () => {
  test("emits a record carrying rendered msg, msgId, msgKey and top-level params", async () => {
    const home = await makeTestHome();
    try {
      const lines: string[] = [];
      initLogger("server", {
        level: "debug",
        env: { CLIMON_HOME: home } as NodeJS.ProcessEnv,
        extraStreams: [{ stream: captureStream(lines), level: "debug" }],
      });
      logMsg(getLogger(), "debug", "srv.probe", { url: "https://x/" }, CAT);
      const record = JSON.parse(lines.join("").trim().split("\n").pop() as string);
      expect(record.msg).toBe("probing https://x/health");
      expect(record.msgId).toBe("0000000b");
      expect(record.msgKey).toBe("srv.probe");
      expect(record.url).toBe("https://x/");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
