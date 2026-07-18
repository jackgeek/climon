export type HarnessPlatform = "macos" | "linux" | "windows";
export type HarnessStatus = "automated" | "manual";
export type ScenarioKey =
  | "client-server.headless-dashboard"
  | "client-server.attached-pty";

export interface HarnessCase {
  id: string;
  title: string;
  sourceFile: string;
  status: HarnessStatus;
  suite: string;
  scenario: ScenarioKey;
  platforms: HarnessPlatform[];
  timeoutSeconds: number;
}

export type FailureKind =
  | "catalogue"
  | "build"
  | "server-startup"
  | "client-startup"
  | "pty"
  | "browser"
  | "assertion"
  | "timeout"
  | "cleanup";

export interface CaseResult {
  id: string;
  platform: HarnessPlatform;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  failureKind?: FailureKind;
  message?: string;
  artifactDir: string;
}

export class HarnessError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "HarnessError";
  }
}
