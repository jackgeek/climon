import {
  HarnessError,
  type NonPassingExpectation,
  type OutcomeComparison,
  type PlatformExpectation,
  type SubcheckResult,
} from "./types.js";

function failedSubcheckNames(subchecks: readonly SubcheckResult[]): string[] {
  return subchecks
    .filter((subcheck) => subcheck.status === "failed")
    .map((subcheck) => subcheck.name);
}

function parseReviewAfter(reviewAfter: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewAfter)) {
    throw new HarnessError(
      "prerequisite",
      `Invalid reviewAfter date: ${reviewAfter}`
    );
  }

  const deadline = new Date(`${reviewAfter}T23:59:59.999Z`);
  const [yearText, monthText, dayText] = reviewAfter.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (
    Number.isNaN(deadline.valueOf()) ||
    deadline.getUTCFullYear() !== year ||
    deadline.getUTCMonth() + 1 !== month ||
    deadline.getUTCDate() !== day
  ) {
    throw new HarnessError(
      "prerequisite",
      `Invalid reviewAfter date: ${reviewAfter}`
    );
  }

  return deadline;
}

function expectationLabel(expectation: NonPassingExpectation): string {
  return expectation.expected === "known-failure"
    ? "known failure"
    : "partial expectation";
}

function expectationDetails(expectation: NonPassingExpectation): string {
  return `${expectation.reason} (tracking: ${expectation.tracking}; review after: ${expectation.reviewAfter})`;
}

export function compareExpectation(
  expectation: PlatformExpectation,
  subchecks: readonly SubcheckResult[],
  now = new Date()
): OutcomeComparison {
  const failedSubchecks = failedSubcheckNames(subchecks);

  if (expectation.expected === "unsupported") {
    return {
      status: "unsupported",
      blocking: false,
      failedSubchecks: [],
      message: `Unsupported on this platform: ${expectation.reason}`,
    };
  }

  if (expectation.expected === "pass") {
    if (failedSubchecks.length === 0) {
      return {
        status: "passed",
        blocking: false,
        failedSubchecks: [],
      };
    }

    return {
      status: "unexpected-failure",
      blocking: true,
      failedSubchecks,
    };
  }

  const reviewDeadline = parseReviewAfter(expectation.reviewAfter);

  if (now.getTime() > reviewDeadline.getTime()) {
    return {
      status: "expired-expectation",
      blocking: true,
      failedSubchecks,
      message: `Expectation expired on ${expectation.reviewAfter}: ${expectation.reason} (tracking: ${expectation.tracking})`,
    };
  }

  if (failedSubchecks.length === 0) {
    return {
      status: "unexpected-pass",
      blocking: true,
      failedSubchecks: [],
      message: `Unexpected pass for ${expectationLabel(expectation)}: ${expectationDetails(expectation)}`,
    };
  }

  const allowedFailures = new Set(expectation.allowedFailedSubchecks);
  const unexpectedFailures = failedSubchecks.filter(
    (failedSubcheck) => !allowedFailures.has(failedSubcheck)
  );

  if (unexpectedFailures.length > 0) {
    return {
      status: "unexpected-failure",
      blocking: true,
      failedSubchecks,
      message: `Unexpected failed subchecks for ${expectationLabel(expectation)}: ${unexpectedFailures.join(
        ", "
      )}`,
    };
  }

  return {
    status:
      expectation.expected === "partial"
        ? "expected-partial"
        : "expected-failure",
    blocking: false,
    failedSubchecks,
    message:
      expectation.expected === "partial"
        ? `Expected partial result: ${expectationDetails(expectation)}`
        : `Expected known failure: ${expectationDetails(expectation)}`,
  };
}
