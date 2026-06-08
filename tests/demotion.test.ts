import { describe, expect, test } from "bun:test";
import { demote } from "../src/remote/demotion.js";

describe("demote primitive", () => {
  test("runs spawnUplink, stopLocalServer, closeListener, removeBeacons — in order", async () => {
    const calls: string[] = [];
    await demote({
      spawnUplink: () => calls.push("spawnUplink"),
      stopLocalServer: async () => { calls.push("stopLocalServer"); },
      closeListener: async () => { calls.push("closeListener"); },
      removeBeacons: async () => { calls.push("removeBeacons"); }
    });
    expect(calls).toEqual(["spawnUplink", "stopLocalServer", "closeListener", "removeBeacons"]);
  });

  test("awaits each async step before the next", async () => {
    const calls: string[] = [];
    await demote({
      spawnUplink: () => calls.push("spawnUplink"),
      stopLocalServer: async () => { await Promise.resolve(); calls.push("stopLocalServer"); },
      closeListener: async () => { await Promise.resolve(); calls.push("closeListener"); },
      removeBeacons: async () => { await Promise.resolve(); calls.push("removeBeacons"); }
    });
    expect(calls).toEqual(["spawnUplink", "stopLocalServer", "closeListener", "removeBeacons"]);
  });
});
