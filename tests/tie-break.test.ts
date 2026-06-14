import { describe, expect, test } from "bun:test";
import { dualPromoteSettleDecision, tieBreakOutcome } from "../src/server/tie-break.js";

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

describe("dualPromoteSettleDecision (newest start wins)", () => {
  test("local started later than peer → win, regardless of OS", () => {
    // Windows newcomer taking over an older WSL host (the reported scenario).
    expect(dualPromoteSettleDecision({ localIsWsl: false, localStartedAt: 200, peerStartedAt: 100 })).toBe("win");
    // WSL newcomer taking over an older Windows host.
    expect(dualPromoteSettleDecision({ localIsWsl: true, localStartedAt: 200, peerStartedAt: 100 })).toBe("win");
  });

  test("local started earlier than peer → lose, regardless of OS", () => {
    expect(dualPromoteSettleDecision({ localIsWsl: true, localStartedAt: 100, peerStartedAt: 200 })).toBe("lose");
    expect(dualPromoteSettleDecision({ localIsWsl: false, localStartedAt: 100, peerStartedAt: 200 })).toBe("lose");
  });

  test("both sides converge: the newer one wins and the older one loses", () => {
    const a = { startedAt: 100, isWsl: true };
    const b = { startedAt: 200, isWsl: false };
    const aDecision = dualPromoteSettleDecision({ localIsWsl: a.isWsl, localStartedAt: a.startedAt, peerStartedAt: b.startedAt });
    const bDecision = dualPromoteSettleDecision({ localIsWsl: b.isWsl, localStartedAt: b.startedAt, peerStartedAt: a.startedAt });
    expect(aDecision).toBe("lose");
    expect(bDecision).toBe("win");
  });

  test("exact start-time tie falls back to deterministic OS rule (WSL wins)", () => {
    expect(dualPromoteSettleDecision({ localIsWsl: true, localStartedAt: 100, peerStartedAt: 100 })).toBe("win");
    expect(dualPromoteSettleDecision({ localIsWsl: false, localStartedAt: 100, peerStartedAt: 100 })).toBe("lose");
  });

  test("peer predating the startedAt field falls back to deterministic OS rule", () => {
    expect(dualPromoteSettleDecision({ localIsWsl: true, localStartedAt: 100, peerStartedAt: undefined })).toBe("win");
    expect(dualPromoteSettleDecision({ localIsWsl: false, localStartedAt: 100, peerStartedAt: undefined })).toBe("lose");
  });
});
