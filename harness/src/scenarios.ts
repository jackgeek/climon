import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ScenarioKey, FailureKind, HarnessCase } from "./types.js";
import { HarnessError } from "./types.js";
import type { HarnessEnvironment } from "./environment.js";
import type { DashboardDriver } from "./dashboard.js";
import type { Page } from "@playwright/test";
import { spawnPtySession } from "./pty.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** Safe session ID characters: alphanumeric, hyphens, underscores. */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Expected echo marker prefix. Override with CLIMON_HARNESS_EXPECT_ECHO env
 * variable for deliberate-failure evidence testing (default: CIH_ECHO).
 */
const EXPECT_ECHO = process.env.CLIMON_HARNESS_EXPECT_ECHO ?? "CIH_ECHO";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ScenarioContext {
  caseDefinition: HarnessCase;
  environment: HarnessEnvironment;
  dashboard: DashboardDriver;
  page: Page;
  artifactDir: string;
}

export type Scenario = (ctx: ScenarioContext) => Promise<void>;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse the session ID from headless client stdout.
 * Expects exactly one non-empty line matching safe session ID characters.
 */
export function parseHeadlessStdout(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    throw new HarnessError(
      "client-startup",
      "headless client produced no stdout"
    );
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length !== 1) {
    throw new HarnessError(
      "client-startup",
      `expected exactly one non-empty line from headless client, got ${lines.length}: ${JSON.stringify(trimmed.slice(0, 200))}`
    );
  }
  const sessionId = lines[0].trim();
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new HarnessError(
      "client-startup",
      `session ID contains unsafe characters: ${JSON.stringify(sessionId)}`
    );
  }
  return sessionId;
}

/**
 * Classify an error into a FailureKind and message for CaseResult reporting.
 */
export function classifyError(error: unknown): {
  kind: FailureKind;
  message: string;
} {
  if (error instanceof HarnessError) {
    return { kind: error.kind, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message)) {
    return { kind: "timeout", message };
  }
  return { kind: "assertion", message };
}

// ── Scenarios ───────────────────────────────────────────────────────────────

async function headlessDashboardScenario(ctx: ScenarioContext): Promise<void> {
  const { caseDefinition, environment, dashboard, artifactDir } = ctx;
  const token = randomUUID();

  const result = await environment.runCommand({
    file: environment.artifacts.clientPath,
    args: [
      "run",
      "--headless",
      "--name",
      caseDefinition.id,
      process.execPath,
      environment.artifacts.fixturePath,
    ],
    cwd: environment.root,
    env: { ...environment.runtimeEnv },
    timeoutMs: 30_000,
    stdoutPath: join(artifactDir, "headless-stdout.log"),
    stderrPath: join(artifactDir, "headless-stderr.log"),
  });

  if (result.code !== 0) {
    throw new HarnessError(
      "client-startup",
      `headless client exited with code ${result.code}`
    );
  }
  const sessionId = parseHeadlessStdout(result.stdout);
  environment.trackSession(sessionId);

  await dashboard.open(environment.baseUrl);
  await dashboard.waitForSessionStatus(sessionId, "running");
  await dashboard.openTerminal(sessionId);
  await dashboard.waitForTerminalText("CIH_READY");

  await dashboard.sendTerminalLine(`PING ${token}`);
  await dashboard.waitForTerminalText(`${EXPECT_ECHO} ${token}`);

  await dashboard.sendTerminalLine("EXIT 0");
  await dashboard.waitForSessionStatus(sessionId, "completed");
  await environment.waitForSessionStatus(sessionId, "completed");

  const meta = await environment.readSessionMeta(sessionId);
  if (meta.exitCode !== 0) {
    throw new HarnessError(
      "assertion",
      `expected exitCode 0, got ${meta.exitCode}`
    );
  }
}

async function attachedPtyScenario(ctx: ScenarioContext): Promise<void> {
  const { caseDefinition, environment, dashboard, page, artifactDir } = ctx;
  const token = randomUUID();

  const pty = await spawnPtySession({
    file: environment.artifacts.clientPath,
    args: [
      "run",
      "--name",
      caseDefinition.id,
      process.execPath,
      environment.artifacts.fixturePath,
    ],
    cwd: environment.root,
    env: environment.runtimeEnv,
    logPath: join(artifactDir, "pty.log"),
  });

  try {
    await pty.waitFor("CIH_READY", 30_000);

    const sessionId = await environment.findSessionIdByName(caseDefinition.id);
    environment.trackSession(sessionId);

    // Dashboard auto-selects the only session; do NOT click session item
    await dashboard.open(environment.baseUrl);
    await dashboard.waitForSessionStatus(sessionId, "running");

    // Wait for terminal surface to appear. If it's not auto-displayed after
    // session selection, try a read-only click on the session item (selects
    // without arming take-control). Do NOT click "Open terminal".
    const terminal = page.locator('[data-testid="session-terminal"]');
    const terminalVisible = await terminal.isVisible().catch(() => false);
    if (!terminalVisible) {
      await dashboard.session(sessionId).click();
      await terminal.waitFor({ timeout: 15_000 });
    }
    await dashboard.waitForTerminalText("CIH_READY", 15_000);

    pty.writeLine(`PING ${token}`);
    await pty.waitFor(`${EXPECT_ECHO} ${token}`, 15_000);

    pty.writeLine("EXIT 0");
    const exitCode = await pty.waitForExit(30_000);
    if (exitCode !== 0) {
      throw new HarnessError(
        "assertion",
        `PTY exited with code ${exitCode}, expected 0`
      );
    }

    await dashboard.waitForSessionStatus(sessionId, "completed");
    await environment.waitForSessionStatus(sessionId, "completed");

    const meta = await environment.readSessionMeta(sessionId);
    if (meta.exitCode !== 0) {
      throw new HarnessError(
        "assertion",
        `expected exitCode 0, got ${meta.exitCode}`
      );
    }
  } finally {
    pty.kill();
  }
}

// ── Registry ────────────────────────────────────────────────────────────────

export const SCENARIOS: Record<ScenarioKey, Scenario> = {
  "client-server.headless-dashboard": headlessDashboardScenario,
  "client-server.attached-pty": attachedPtyScenario,
};
