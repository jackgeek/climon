import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { CaseArtifacts, caseArtifactDir } from "./artifacts.js";
import type { BuildArtifacts } from "./build-cache.js";
import type { CommandRunner, CommandSpec } from "./command.js";
import { ProcessLedger, type OwnedProcess } from "./process-ledger.js";
import { SessionLedger, type SessionStatus } from "./session-ledger.js";
import { HarnessError, type HarnessPlatform } from "./types.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "disconnected"]);

type FsMkdir = typeof mkdir;
type FsReadFile = typeof readFile;
type FsWriteFile = typeof writeFile;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RuntimeContext {
  root: string;
  home: string;
  baseUrl: string;
  env: Record<string, string>;
  artifacts: CaseArtifacts;
  processes: ProcessLedger;
  sessions: SessionLedger;
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export interface RuntimeSupervisorOptions {
  root: string;
  darId: string;
  artifactRoot: string;
  platform: HarnessPlatform;
  build: BuildArtifacts;
  runner: CommandRunner;
  startupTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

export interface SpawnProcessSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdoutPath: string;
  stderrPath: string;
  shell: false;
  label: string;
  platform: HarnessPlatform;
}

export interface RuntimeSupervisorDependencies {
  spawnProcess?: (spec: SpawnProcessSpec) => Promise<OwnedProcess>;
  fetch?: FetchLike;
  launchBrowser?: () => Promise<Browser>;
  fs?: {
    mkdir?: FsMkdir;
    readFile?: FsReadFile;
    writeFile?: FsWriteFile;
  };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  processLedgerDependencies?: {
    client?: ConstructorParameters<typeof ProcessLedger>[1];
    server?: ConstructorParameters<typeof ProcessLedger>[1];
  };
}

interface StartupState {
  artifacts: CaseArtifacts;
  home: string;
  logsDir: string;
  env: Record<string, string>;
  processes: ProcessLedger;
  serverProcesses: ProcessLedger;
  sessions: RuntimeSessionLedger;
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
}

interface ServerState {
  pid: number;
  port: number;
}

class RuntimeSessionLedger extends SessionLedger {
  private readonly runtimeTrackedIds = new Set<string>();

  public override track(id: string): void {
    super.track(id);
    this.runtimeTrackedIds.add(id);
  }

  public trackedSessionIds(): string[] {
    return [...this.runtimeTrackedIds];
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIncomingCi(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI?.trim().toLowerCase();
  return value === "true" || value === "1";
}

function runtimeEnv(
  inherited: NodeJS.ProcessEnv,
  home: string,
  build: BuildArtifacts,
  platform: HarnessPlatform
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(inherited).filter(([, value]) => value !== undefined)
  ) as Record<string, string>;

  env.CLIMON_HOME = home;
  env.CLIMON_CLIENT_BIN = build.clientPath;
  env.CLIMON_SESSION_ENGINE = "actor";
  env.CLIMON_COLS = "100";
  env.CLIMON_ROWS = "30";
  env.CI = "true";
  env.NO_COLOR = "1";

  if (
    platform === "linux" &&
    isIncomingCi(inherited) &&
    inherited.CLIMON_DISABLE_SETSID === "1"
  ) {
    env.CLIMON_DISABLE_SETSID = "1";
  } else {
    delete env.CLIMON_DISABLE_SETSID;
  }

  return env;
}

function runtimeConfig(): Record<string, unknown> {
  return {
    version: 1,
    telemetry: { enabled: false },
    update: { auto: false },
    remote: {
      enabled: false,
      discover: false,
      autoLink: false,
    },
    feature: {
      remoteSpawn: "disabled",
      wslBridge: "disabled",
      remotes: "disabled",
    },
  };
}

function baseUrlForPort(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new HarnessError("server-startup", `Invalid dashboard port in server.json: ${port}`);
  }
  return new URL(`http://127.0.0.1:${port}/`).toString();
}

function parseServerState(raw: string): ServerState | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const candidate = parsed as Record<string, unknown>;
  if (
    !Number.isInteger(candidate.pid) ||
    typeof candidate.pid !== "number" ||
    candidate.pid <= 0 ||
    !Number.isInteger(candidate.port) ||
    typeof candidate.port !== "number" ||
    candidate.port <= 0
  ) {
    return undefined;
  }

  return {
    pid: candidate.pid,
    port: candidate.port,
  };
}

function cleanupMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function cleanupError(errors: unknown[]): HarnessError {
  return new HarnessError(
    "cleanup",
    errors.map((error) => cleanupMessage(error)).join("; "),
    { cause: new AggregateError(errors, "runtime cleanup failed") }
  );
}

function isConnectionNotReadyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!(current instanceof Error)) {
      continue;
    }

    const code = (current as NodeJS.ErrnoException).code;
    if (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "EPIPE" ||
      code === "ETIMEDOUT" ||
      code === "EHOSTUNREACH" ||
      code === "ENETUNREACH" ||
      code === "ENOENT" ||
      current.name === "AbortError" ||
      current.name === "TimeoutError"
    ) {
      return true;
    }

    if ("cause" in current) {
      queue.push((current as Error & { cause?: unknown }).cause);
    }
  }

  return false;
}

async function spawnOwnedProcess(spec: SpawnProcessSpec): Promise<OwnedProcess> {
  await Promise.all([
    mkdir(dirname(spec.stdoutPath), { recursive: true }),
    mkdir(dirname(spec.stderrPath), { recursive: true }),
  ]);

  const stdout = createWriteStream(spec.stdoutPath);
  const stderr = createWriteStream(spec.stderrPath);
  let child;

  try {
    child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: spec.shell,
      detached: spec.platform !== "windows",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    stdout.end();
    stderr.end();
    throw new HarnessError(
      "server-startup",
      `Failed to start ${spec.label}: ${spec.file} ${spec.args.join(" ")}`,
      { cause: error }
    );
  }

  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);

  const exitPromise = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("exit", (code) => resolve(code));
  }).finally(() => {
    stdout.end();
    stderr.end();
  });

  const pid = child.pid;
  if (pid === undefined || pid <= 0) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore startup kill failures.
    }
    await exitPromise;
    throw new HarnessError("server-startup", `Spawned ${spec.label} without a valid pid`);
  }

  return {
    pid,
    label: spec.label,
    platform: spec.platform,
    processGroup: spec.platform === "windows" ? undefined : pid,
    wait: () => exitPromise,
  };
}

async function waitForServerReady(
  home: string,
  pid: number,
  deadline: number,
  dependencies: { fetch: FetchLike; now: () => number; sleep: (ms: number) => Promise<void> } &
    Required<Pick<NonNullable<RuntimeSupervisorDependencies["fs"]>, "readFile">> & {
      pollIntervalMs: number;
    }
): Promise<string> {
  while (true) {
    if (dependencies.now() >= deadline) {
      throw new HarnessError(
        "timeout",
        `Timed out waiting for server.json for dashboard pid ${pid}`
      );
    }

    let raw: string;
    try {
      raw = await dependencies.readFile(join(home, "server.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await dependencies.sleep(dependencies.pollIntervalMs);
        continue;
      }
      throw error;
    }

    const state = parseServerState(raw);
    if (state === undefined) {
      throw new HarnessError("server-startup", "Malformed server.json during dashboard startup");
    }
    if (state.pid !== pid) {
      throw new HarnessError(
        "server-startup",
        `Dashboard server.json pid ${state.pid} does not match spawned pid ${pid}`
      );
    }

    const baseUrl = baseUrlForPort(state.port);

    try {
      const response = await dependencies.fetch(new URL("health", baseUrl), {
        signal: AbortSignal.timeout(Math.max(1, deadline - dependencies.now())),
      });
      if (!response.ok) {
        throw new HarnessError(
          "server-startup",
          `Dashboard health probe failed with HTTP ${response.status} at ${baseUrl}health`
        );
      }

      const body = await response.json();
      if (
        typeof body !== "object" ||
        body === null ||
        (body as { ok?: unknown }).ok !== true
      ) {
        throw new HarnessError(
          "server-startup",
          `Dashboard health probe did not report ok=true at ${baseUrl}health`
        );
      }

      return baseUrl;
    } catch (error) {
      if (error instanceof HarnessError) {
        throw error;
      }
      if (isConnectionNotReadyError(error)) {
        await dependencies.sleep(dependencies.pollIntervalMs);
        continue;
      }
      throw new HarnessError("server-startup", `Dashboard health probe failed: ${cleanupMessage(error)}`, {
        cause: error,
      });
    }
  }
}

export class RuntimeSupervisor {
  public readonly context: RuntimeContext;
  private disposed = false;

  private constructor(
    private readonly options: Required<RuntimeSupervisorOptions>,
    context: RuntimeContext,
    private readonly sessions: RuntimeSessionLedger,
    private readonly serverProcesses: ProcessLedger,
    private readonly logsDir: string,
    private readonly now: () => number
  ) {
    this.context = context;
  }

  public static async create(
    options: RuntimeSupervisorOptions,
    dependencies: RuntimeSupervisorDependencies = {}
  ): Promise<RuntimeSupervisor> {
    const resolvedOptions: Required<RuntimeSupervisorOptions> = {
      ...options,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      cleanupTimeoutMs: options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
    };
    const fsMkdir = dependencies.fs?.mkdir ?? mkdir;
    const fsReadFile = dependencies.fs?.readFile ?? readFile;
    const fsWriteFile = dependencies.fs?.writeFile ?? writeFile;
    const now = dependencies.now ?? Date.now;
    const sleep = dependencies.sleep ?? defaultSleep;
    const pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const spawnProcess = dependencies.spawnProcess ?? spawnOwnedProcess;
    const fetchFn = dependencies.fetch ?? fetch;
    const launchBrowser = dependencies.launchBrowser ?? (async () => chromium.launch({ headless: true }));
    const artifacts = new CaseArtifacts(caseArtifactDir(resolvedOptions.artifactRoot, resolvedOptions.darId));
    const home = join(artifacts.dir, "temp", "h");
    const logsDir = join(artifacts.dir, "logs");
    const env = runtimeEnv(process.env, home, resolvedOptions.build, resolvedOptions.platform);
    const processes = new ProcessLedger(artifacts.dir, dependencies.processLedgerDependencies?.client);
    const serverProcesses = new ProcessLedger(join(artifacts.dir, "server"), dependencies.processLedgerDependencies?.server);
    const sessions = new RuntimeSessionLedger(home, {
      now,
      sleep,
      pollIntervalMs,
      readFile: fsReadFile,
    });
    const state: StartupState = {
      artifacts,
      home,
      logsDir,
      env,
      processes,
      serverProcesses,
      sessions,
    };

    try {
      await artifacts.initialize();
      await Promise.all([
        fsMkdir(home, { recursive: true }),
        fsMkdir(logsDir, { recursive: true }),
      ]);
      await fsWriteFile(
        join(home, "config.jsonc"),
        `${JSON.stringify(runtimeConfig(), null, 2)}\n`,
        "utf8"
      );

      const server = await spawnProcess({
        file: resolvedOptions.build.serverPath,
        args: ["server", "--no-takeover", "--port", "0"],
        cwd: resolvedOptions.root,
        env,
        stdoutPath: join(logsDir, "server.stdout.log"),
        stderrPath: join(logsDir, "server.stderr.log"),
        shell: false,
        label: "climon-server",
        platform: resolvedOptions.platform,
      });
      await serverProcesses.register(server);

      const baseUrl = await waitForServerReady(home, server.pid, now() + resolvedOptions.startupTimeoutMs, {
        fetch: fetchFn,
        now,
        sleep,
        readFile: fsReadFile,
        pollIntervalMs,
      });

      const browser = await launchBrowser();
      state.browser = browser;
      const context = await browser.newContext();
      state.context = context;
      const page = await context.newPage();
      state.page = page;

      return new RuntimeSupervisor(
        resolvedOptions,
        {
          root: resolvedOptions.root,
          home,
          baseUrl,
          env,
          artifacts,
          processes,
          sessions,
          browser,
          context,
          page,
        },
        sessions,
        serverProcesses,
        logsDir,
        now
      );
    } catch (error) {
      await RuntimeSupervisor.cleanupStartupFailure(state).catch(() => undefined);
      throw error;
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    const errors: unknown[] = [];
    const deadline = this.now() + this.options.cleanupTimeoutMs;
    const liveTrackedIds: string[] = [];

    try {
      await this.context.page.close();
    } catch (error) {
      errors.push(error);
    }

    try {
      await this.context.context.close();
    } catch (error) {
      errors.push(error);
    }

    for (const id of this.sessions.trackedSessionIds()) {
      try {
        const meta = await this.context.sessions.read(id);
        if (!TERMINAL_STATUSES.has(meta.status)) {
          liveTrackedIds.push(id);
          const result = await this.options.runner.run(this.killCommand(id));
          if (result.code !== 0) {
            throw new HarnessError(
              "cleanup",
              `climon kill ${id} exited with code ${result.code}`
            );
          }
        }
      } catch (error) {
        errors.push(error);
      }
    }

    for (const id of liveTrackedIds) {
      try {
        await this.context.sessions.waitForTerminalStatus(id, deadline);
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      await this.context.processes.terminateAll();
    } catch (error) {
      errors.push(error);
    }

    try {
      await this.serverProcesses.terminateAll();
    } catch (error) {
      errors.push(error);
    }

    try {
      await this.context.processes.assertNoSurvivors();
    } catch (error) {
      errors.push(error);
    }

    try {
      await this.serverProcesses.assertNoSurvivors();
    } catch (error) {
      errors.push(error);
    }

    try {
      await this.context.artifacts.snapshotTree(this.context.home, "home");
    } catch (error) {
      errors.push(error);
    }

    try {
      await this.context.browser.close();
    } catch (error) {
      errors.push(error);
    }

    this.disposed = true;

    if (errors.length > 0) {
      throw cleanupError(errors);
    }
  }

  private killCommand(id: string): CommandSpec {
    return {
      file: this.options.build.clientPath,
      args: ["kill", id],
      cwd: this.options.root,
      env: this.context.env,
      timeoutMs: this.options.cleanupTimeoutMs,
      stdoutPath: join(this.logsDir, `kill-${id}.stdout.log`),
      stderrPath: join(this.logsDir, `kill-${id}.stderr.log`),
    };
  }

  private static async cleanupStartupFailure(state: StartupState): Promise<void> {
    const cleanupAttempts: Promise<unknown>[] = [];

    if (state.page) {
      cleanupAttempts.push(state.page.close().catch(() => undefined));
    }
    if (state.context) {
      cleanupAttempts.push(state.context.close().catch(() => undefined));
    }
    if (state.browser) {
      cleanupAttempts.push(state.browser.close().catch(() => undefined));
    }

    cleanupAttempts.push(state.processes.terminateAll().catch(() => undefined));
    cleanupAttempts.push(state.serverProcesses.terminateAll().catch(() => undefined));

    await Promise.allSettled(cleanupAttempts);
  }
}
