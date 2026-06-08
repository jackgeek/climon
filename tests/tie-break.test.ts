import { describe, expect, test } from "bun:test";
import { tieBreakOutcome } from "../src/server/tie-break.js";

describe("tieBreakOutcome (WSL wins ties)", () => {
  test("no concurrent peer host → stay host", () => {
    expect(tieBreakOutcome({ localIsWsl: true, peerServerPresent: false })).toBe("stay-host");
    expect(tieBreakOutcome({ localIsWsl: false, peerServerPresent: false })).toBe("stay-host");
  });

  test("both promoted, this OS is WSL → stay host (winner)", () => {
    expect(tieBreakOutcome({ localIsWsl: true, peerServerPresent: true })).toBe("stay-host");
  });

  test("both promoted, this OS is Windows → demote self (loser)", () => {
    expect(tieBreakOutcome({ localIsWsl: false, peerServerPresent: true })).toBe("demote-self");
  });
});
