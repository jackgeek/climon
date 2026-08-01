export type HarnessPlatform = "linux" | "macos" | "windows";

export type ExpectedOutcome =
  | "pass"
  | "known-failure"
  | "partial"
  | "unsupported";

export type SubcheckStatus = "passed" | "failed";

export type CaseStatus =
  | "passed"
  | "expected-failure"
  | "expected-partial"
  | "unsupported"
  | "unexpected-failure"
  | "unexpected-pass"
  | "expired-expectation"
  | "setup-failure"
  | "cleanup-failure";

export type FailureKind =
  | "prerequisite"
  | "build"
  | "server-startup"
  | "client-startup"
  | "pty"
  | "browser"
  | "assertion"
  | "timeout"
  | "cleanup";

export interface PassingExpectation {
  expected: "pass";
}

export interface NonPassingExpectation {
  expected: "known-failure" | "partial";
  reason: string;
  tracking: string;
  reviewAfter: string;
  allowedFailedSubchecks: string[];
}

export interface UnsupportedExpectation {
  expected: "unsupported";
  reason: string;
}

export type PlatformExpectation =
  | PassingExpectation
  | NonPassingExpectation
  | UnsupportedExpectation;

export interface SubcheckResult {
  name: string;
  title: string;
  status: SubcheckStatus;
  durationMs: number;
  message?: string;
  evidence?: string[];
}

export interface OutcomeComparison {
  status: CaseStatus;
  blocking: boolean;
  failedSubchecks: string[];
  message?: string;
}

export interface CaseResult extends OutcomeComparison {
  darId: string;
  title: string;
  platform: HarnessPlatform;
  durationMs: number;
  subchecks: SubcheckResult[];
  artifactDir: string;
}

export class HarnessError extends Error {
  public readonly kind: FailureKind;
  public override readonly cause?: unknown;

  public constructor(
    kind: FailureKind,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "HarnessError";
    this.kind = kind;
    this.cause = options?.cause;
  }
}
