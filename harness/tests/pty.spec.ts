import { expect, test } from "@playwright/test";
import { resolve, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnPtySession } from "../src/pty.js";
import { HarnessError } from "../src/types.js";

const fixtureScript = resolve(
  import.meta.dirname,
  "../fixtures/echo-session.mjs"
);

test("pty: echo-session PING/ECHO/EXIT protocol", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "climon-pty-"));
  const session = await spawnPtySession({
    file: process.execPath,
    args: [fixtureScript],
    cwd: resolve(import.meta.dirname, "../.."),
    env: process.env,
    logPath: join(logDir, "pty.log"),
  });

  try {
    await session.waitFor("CIH_READY", 10_000);

    session.writeLine("PING token-abc");

    await session.waitFor("CIH_ECHO token-abc", 10_000);

    session.writeLine("EXIT 0");

    const code = await session.waitForExit(10_000);
    expect(code).toBe(0);
  } finally {
    session.kill();
  }
});

test("pty: timeout rejects with HarnessError including marker and recent output", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "climon-pty-"));
  const session = await spawnPtySession({
    file: process.execPath,
    args: [fixtureScript],
    cwd: resolve(import.meta.dirname, "../.."),
    env: process.env,
    logPath: join(logDir, "pty-timeout.log"),
  });

  try {
    // Wait for ready first so there is some output in the buffer
    await session.waitFor("CIH_READY", 10_000);

    // Wait for a marker that will never appear
    const err = await session
      .waitFor("NEVER_APPEARS_MARKER_XYZ", 500)
      .catch((e) => e);

    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).kind).toBe("timeout");
    expect((err as HarnessError).message).toContain("NEVER_APPEARS_MARKER_XYZ");
    expect((err as HarnessError).message).toContain("CIH_READY");
  } finally {
    session.kill();
  }
});
