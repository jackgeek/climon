import { describe, expect, test } from "bun:test";
import { compareOutcome } from "../src/expectations.js";
import type {
  PlatformExpectation,
  SubcheckResult,
} from "../src/types.js";

function failedSubcheck(name: string): SubcheckResult {
  return {
    name,
    status: "failed",
    durationMs: 25,
  };
}

function passedSubcheck(name: string): SubcheckResult {
  return {
    name,
    status: "passed",
    durationMs: 10,
  };
}

describe("compareOutcome", () => {
  test("returns passed when pass is expected and every subcheck passes", () => {
    const expectation: PlatformExpectation = { expected: "pass" };

    expect(
      compareOutcome(expectation, [
        passedSubcheck("setup"),
        passedSubcheck("assertions"),
      ])
    ).toEqual({
      status: "passed",
      blocking: false,
      failedSubchecks: [],
    });
  });

  test("marks a failed subcheck as an unexpected failure when pass was expected", () => {
    const expectation: PlatformExpectation = { expected: "pass" };

    expect(
      compareOutcome(expectation, [passedSubcheck("setup"), failedSubcheck("assertions")])
    ).toEqual({
      status: "unexpected-failure",
      blocking: true,
      failedSubchecks: ["assertions"],
    });
  });

  test("marks an allowed partial failure as expected-partial", () => {
    const expectation: PlatformExpectation = {
      expected: "partial",
      reason: "PTY resize is flaky on CI VMs",
      tracking: "https://tracker.example/pty-resize",
      reviewAfter: "2026-08-15",
      allowedFailedSubchecks: ["resize"],
    };

    expect(
      compareOutcome(expectation, [passedSubcheck("setup"), failedSubcheck("resize")], new Date("2026-08-15T12:00:00.000Z"))
    ).toEqual({
      status: "expected-partial",
      blocking: false,
      failedSubchecks: ["resize"],
      message:
        "Expected partial result: PTY resize is flaky on CI VMs (tracking: https://tracker.example/pty-resize; review after: 2026-08-15)",
    });
  });

  test("marks a known failure that fully passes as an unexpected pass", () => {
    const expectation: PlatformExpectation = {
      expected: "known-failure",
      reason: "Windows attach is not implemented yet",
      tracking: "https://tracker.example/windows-attach",
      reviewAfter: "2026-08-15",
      allowedFailedSubchecks: ["attach"],
    };

    expect(compareOutcome(expectation, [passedSubcheck("attach")])).toEqual({
      status: "unexpected-pass",
      blocking: true,
      failedSubchecks: [],
      message:
        "Unexpected pass for known failure: Windows attach is not implemented yet (tracking: https://tracker.example/windows-attach; review after: 2026-08-15)",
    });
  });

  test("marks a non-expired known failure with only declared failed subchecks as expected-failure", () => {
    const expectation: PlatformExpectation = {
      expected: "known-failure",
      reason: "Windows attach is not implemented yet",
      tracking: "https://tracker.example/windows-attach",
      reviewAfter: "2026-08-15",
      allowedFailedSubchecks: ["attach", "cleanup"],
    };

    expect(
      compareOutcome(
        expectation,
        [passedSubcheck("setup"), failedSubcheck("attach"), failedSubcheck("cleanup")],
        new Date("2026-08-14T12:00:00.000Z")
      )
    ).toEqual({
      status: "expected-failure",
      blocking: false,
      failedSubchecks: ["attach", "cleanup"],
      message:
        "Expected known failure: Windows attach is not implemented yet (tracking: https://tracker.example/windows-attach; review after: 2026-08-15)",
    });
  });

  test("fails blocking when a non-passing expectation has expired", () => {
    const expectation: PlatformExpectation = {
      expected: "partial",
      reason: "Browser reconnect intermittently fails",
      tracking: "https://tracker.example/browser-reconnect",
      reviewAfter: "2026-08-15",
      allowedFailedSubchecks: ["reconnect"],
    };

    expect(
      compareOutcome(expectation, [failedSubcheck("reconnect")], new Date("2026-08-16T00:00:00.000Z"))
    ).toEqual({
      status: "expired-expectation",
      blocking: true,
      failedSubchecks: ["reconnect"],
      message:
        "Expectation expired on 2026-08-15: Browser reconnect intermittently fails (tracking: https://tracker.example/browser-reconnect)",
    });
  });

  test("marks undeclared failed subchecks under non-passing expectations as unexpected failures", () => {
    const expectation: PlatformExpectation = {
      expected: "known-failure",
      reason: "Browser attach is timing out",
      tracking: "https://tracker.example/browser-attach",
      reviewAfter: "2026-08-15",
      allowedFailedSubchecks: ["attach"],
    };

    expect(
      compareOutcome(expectation, [failedSubcheck("attach"), failedSubcheck("cleanup")])
    ).toEqual({
      status: "unexpected-failure",
      blocking: true,
      failedSubchecks: ["attach", "cleanup"],
      message:
        "Unexpected failed subchecks for known failure: cleanup",
    });
  });

  test("returns unsupported as non-blocking without failed subchecks", () => {
    const expectation: PlatformExpectation = {
      expected: "unsupported",
      reason: "Not available on this OS",
    };

    expect(compareOutcome(expectation, [failedSubcheck("ignored")])).toEqual({
      status: "unsupported",
      blocking: false,
      failedSubchecks: [],
      message: "Unsupported on this platform: Not available on this OS",
    });
  });

  test("rejects invalid reviewAfter values", () => {
    const expectation: PlatformExpectation = {
      expected: "partial",
      reason: "Invalid review date fixture",
      tracking: "https://tracker.example/invalid-review-after",
      reviewAfter: "2026-02-31",
      allowedFailedSubchecks: ["assertions"],
    };

    expect(() => compareOutcome(expectation, [failedSubcheck("assertions")])).toThrow(
      "Invalid reviewAfter date: 2026-02-31"
    );
  });
});
