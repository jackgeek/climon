import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SessionLedger,
  type SessionMeta,
} from "../src/session-ledger.js";

function makeWorkspace(name: string): string {
  const workspace = resolve(
    import.meta.dir,
    "..",
    ".test-workspace",
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

function writeSession(home: string, id: string, value: Record<string, unknown>) {
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "sessions", `${id}.json`), `${JSON.stringify(value)}\n`);
}

describe("SessionLedger", () => {
  test("tracks owned ids and reads matching metadata with optional exitCode", async () => {
    const workspace = makeWorkspace("session-ledger-read");
    const id = "rare-geckos-jam";
    const home = join(workspace, "home");
    const ledger = new SessionLedger(home);

    try {
      writeSession(home, id, {
        id,
        status: "completed",
        exitCode: 0,
        displayCommand: "echo ok",
      });

      ledger.track(id);

      const meta = await ledger.read(id);

      expect(meta).toEqual({
        id,
        status: "completed",
        exitCode: 0,
        displayCommand: "echo ok",
      } satisfies SessionMeta);
      await expect(ledger.waitForStatus(id, "completed", Date.now() + 1_000)).resolves.toEqual(
        meta
      );
      await expect(ledger.waitForTerminalStatus(id, Date.now() + 1_000)).resolves.toEqual(meta);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects duplicate tracked ids and path traversal ids", () => {
    const ledger = new SessionLedger("/home/test");

    ledger.track("boxA~rare-geckos-jam");

    expect(() => ledger.track("boxA~rare-geckos-jam")).toThrow(
      expect.objectContaining({
        name: "HarnessError",
        kind: "prerequisite",
      })
    );
    expect(() => ledger.track("../escape")).toThrow(
      expect.objectContaining({
        name: "HarnessError",
        kind: "prerequisite",
      })
    );
  });

  test("waits deterministically for terminal metadata to appear before the deadline", async () => {
    const workspace = makeWorkspace("session-ledger-wait");
    const id = "sleepy-cats-rest";
    const home = join(workspace, "home");
    let now = 1_000;
    const ledger = new SessionLedger(home, {
      now: () => now,
      sleep: async () => {
        now += 25;
        writeSession(home, id, { id, status: "failed", exitCode: 7 });
      },
      pollIntervalMs: 25,
    });

    try {
      ledger.track(id);

      await expect(ledger.waitForTerminalStatus(id, 1_050)).resolves.toEqual({
        id,
        status: "failed",
        exitCode: 7,
      } satisfies SessionMeta);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("treats disconnected metadata as terminal", async () => {
    const workspace = makeWorkspace("session-ledger-disconnected");
    const id = "remote-session";
    const home = join(workspace, "home");
    const ledger = new SessionLedger(home);

    try {
      ledger.track(id);
      writeSession(home, id, { id, status: "disconnected" });

      await expect(
        ledger.waitForTerminalStatus(id, Date.now() + 1_000)
      ).resolves.toEqual({
        id,
        status: "disconnected",
      } satisfies SessionMeta);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects metadata with a non-string or unknown status", async () => {
    const workspace = makeWorkspace("session-ledger-invalid-status");
    const id = "invalid-status";
    const home = join(workspace, "home");
    const ledger = new SessionLedger(home);

    try {
      ledger.track(id);
      writeSession(home, id, { id, status: 42 });
      await expect(ledger.read(id)).rejects.toThrow(
        "Session metadata for invalid-status has invalid status: 42"
      );

      writeSession(home, id, { id, status: "starting" });
      await expect(ledger.read(id)).rejects.toThrow(
        "Session metadata for invalid-status has invalid status: starting"
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("surfaces malformed or mismatched metadata immediately instead of looping", async () => {
    const workspace = makeWorkspace("session-ledger-invalid");
    const id = "good-id";
    const home = join(workspace, "home");
    let sleepCalls = 0;
    const ledger = new SessionLedger(home, {
      now: () => 5_000,
      sleep: async () => {
        sleepCalls += 1;
      },
    });

    try {
      ledger.track(id);
      writeSession(home, id, {
        id: "wrong-id",
        status: "running",
        exitCode: 1.5,
      });

      const error = await ledger.waitForStatus(id, "running", 6_000).catch((caught: unknown) => caught);

      expect(sleepCalls).toBe(0);
      expect(error).toEqual(
        expect.objectContaining({
          name: "HarnessError",
          kind: "assertion",
          message: expect.stringContaining("wrong-id"),
        })
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("only allows reading owned tracked ids", async () => {
    const ledger = new SessionLedger("/home/test");

    const error = await ledger.read("untracked-id").catch((caught: unknown) => caught);

    expect(error).toEqual(
      expect.objectContaining({
        name: "HarnessError",
        kind: "prerequisite",
      })
    );
  });
});
