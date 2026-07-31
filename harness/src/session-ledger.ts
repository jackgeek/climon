import { readFile } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "./types.js";

export type SessionStatus =
  | "running"
  | "acknowledged"
  | "needs-attention"
  | "completed"
  | "paused"
  | "failed"
  | "disconnected";

export interface SessionMeta extends Record<string, unknown> {
  id: string;
  status: SessionStatus;
  exitCode?: number;
}

interface SessionLedgerDependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  readFile?: typeof readFile;
}

const SESSION_STATUSES = new Set<SessionStatus>([
  "running",
  "acknowledged",
  "needs-attention",
  "completed",
  "paused",
  "failed",
  "disconnected",
]);

const TERMINAL_STATUSES = new Set<SessionStatus>([
  "completed",
  "failed",
  "disconnected",
]);

const SESSION_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new HarnessError("prerequisite", `Invalid session id: ${id}`);
  }
}

export class SessionLedger {
  private readonly trackedIds = new Set<string>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly readTextFile: typeof readFile;
  private readonly sessionsDir: string;

  public constructor(
    climonHome: string,
    dependencies: SessionLedgerDependencies = {}
  ) {
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.pollIntervalMs = dependencies.pollIntervalMs ?? 100;
    this.readTextFile = dependencies.readFile ?? readFile;
    this.sessionsDir = path.resolve(climonHome, "sessions");
  }

  public track(id: string): void {
    validateSessionId(id);
    if (this.trackedIds.has(id)) {
      throw new HarnessError("prerequisite", `Session ${id} is already tracked`);
    }
    this.trackedIds.add(id);
  }

  public async read(id: string): Promise<SessionMeta> {
    this.assertTracked(id);
    const meta = await this.readValidated(id);
    if (meta === undefined) {
      throw new HarnessError("assertion", `Missing metadata for tracked session ${id}`);
    }
    return meta;
  }

  public async waitForStatus(
    id: string,
    status: SessionStatus,
    deadline: number
  ): Promise<SessionMeta> {
    this.assertTracked(id);
    this.assertKnownStatus(status);

    while (true) {
      const meta = await this.readValidated(id);
      if (meta?.status === status) {
        return meta;
      }

      if (this.now() >= deadline) {
        throw new HarnessError(
          "timeout",
          `Timed out waiting for session ${id} to reach status ${status}`
        );
      }

      await this.sleep(this.pollIntervalMs);
    }
  }

  public async waitForTerminalStatus(
    id: string,
    deadline: number
  ): Promise<SessionMeta> {
    this.assertTracked(id);

    while (true) {
      const meta = await this.readValidated(id);
      if (meta && TERMINAL_STATUSES.has(meta.status)) {
        return meta;
      }

      if (this.now() >= deadline) {
        throw new HarnessError(
          "timeout",
          `Timed out waiting for session ${id} to reach a terminal status`
        );
      }

      await this.sleep(this.pollIntervalMs);
    }
  }

  private assertTracked(id: string): void {
    validateSessionId(id);
    if (!this.trackedIds.has(id)) {
      throw new HarnessError("prerequisite", `Session ${id} is not tracked`);
    }
  }

  private assertKnownStatus(status: string): asserts status is SessionStatus {
    if (!SESSION_STATUSES.has(status as SessionStatus)) {
      throw new HarnessError("prerequisite", `Unknown session status: ${status}`);
    }
  }

  private sessionMetaPath(id: string): string {
    const filePath = path.resolve(this.sessionsDir, `${id}.json`);
    const relative = path.relative(this.sessionsDir, filePath);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new HarnessError("prerequisite", `Session path escapes CLIMON_HOME: ${id}`);
    }

    return filePath;
  }

  private async readValidated(id: string): Promise<SessionMeta | undefined> {
    let raw: string;

    try {
      raw = await this.readTextFile(this.sessionMetaPath(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new HarnessError("assertion", `Invalid session metadata JSON for ${id}`, {
        cause: error,
      });
    }

    if (!isRecord(parsed)) {
      throw new HarnessError("assertion", `Session metadata for ${id} must be an object`);
    }
    if (parsed.id !== id) {
      throw new HarnessError(
        "assertion",
        `Session metadata id mismatch for ${id}: ${String(parsed.id)}`
      );
    }
    if (typeof parsed.status !== "string" || !SESSION_STATUSES.has(parsed.status as SessionStatus)) {
      throw new HarnessError(
        "assertion",
        `Session metadata for ${id} has invalid status: ${String(parsed.status)}`
      );
    }
    if (
      parsed.exitCode !== undefined &&
      (!Number.isInteger(parsed.exitCode) || typeof parsed.exitCode !== "number")
    ) {
      throw new HarnessError(
        "assertion",
        `Session metadata for ${id} has invalid exitCode: ${String(parsed.exitCode)}`
      );
    }

    return parsed as SessionMeta;
  }
}
