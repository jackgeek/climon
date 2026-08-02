import { spawnSync } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { HarnessError, type HarnessPlatform } from "./types.js";

export interface OwnedProcess {
  pid: number;
  label: string;
  platform: HarnessPlatform;
  processGroup?: number;
  wait(): Promise<number | null>;
}

interface CommandOptions {
  shell: false;
  stdio: "ignore";
  windowsHide: boolean;
}

interface ProcessLedgerDependencies {
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  runCommand?: (
    file: string,
    args: string[],
    options: CommandOptions
  ) => { status: number | null; error?: unknown };
}

interface OwnedEntry {
  process: OwnedProcess;
  live: boolean;
  exitCode?: number | null;
}

const defaultDependencies: Required<ProcessLedgerDependencies> = {
  kill(pid, signal) {
    process.kill(pid, signal);
  },
  runCommand(file, args, options) {
    const result = spawnSync(file, args, options);
    return { status: result.status, error: result.error };
  },
};

const PROCESS_EXIT_TIMEOUT = Symbol("process-exit-timeout");

export class ProcessLedger {
  private readonly entries = new Map<number, OwnedEntry>();
  private readonly dependencies: Required<ProcessLedgerDependencies>;
  private readonly logPath: string;

  public constructor(
    dir: string,
    dependencies: ProcessLedgerDependencies = {}
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
    this.logPath = path.join(dir, "process-ledger.jsonl");
  }

  public async register(owned: OwnedProcess): Promise<void> {
    if (this.entries.has(owned.pid)) {
      throw new HarnessError(
        "prerequisite",
        `Process ${owned.pid} is already registered`
      );
    }

    this.entries.set(owned.pid, { process: owned, live: true });
    await this.log("register", owned, {
      processGroup: owned.processGroup,
    });
  }

  public async markExited(pid: number, exitCode: number | null): Promise<void> {
    const entry = this.entries.get(pid);
    if (!entry) {
      throw new HarnessError("cleanup", `Cannot mark unowned process ${pid} as exited`);
    }

    if (!entry.live) {
      return;
    }

    entry.live = false;
    entry.exitCode = exitCode;
    await this.log("exit", entry.process, { exitCode });
  }

  public async terminateAll(timeoutMs = 10_000): Promise<void> {
    const failures: Error[] = [];
    const stillRunning = Symbol("still-running");
    const deadline = Date.now() + Math.max(0, timeoutMs);

    for (const entry of this.entries.values()) {
      if (!entry.live) {
        continue;
      }

      const { process: owned } = entry;
      const existingExit = await Promise.race([
        owned.wait(),
        Promise.resolve(stillRunning),
      ]);
      if (existingExit !== stillRunning) {
        await this.markExited(owned.pid, existingExit);
        continue;
      }

      const targetPid =
        owned.platform === "windows"
          ? owned.pid
          : owned.processGroup !== undefined
            ? -owned.processGroup
            : owned.pid;

      await this.log("terminate", owned, { targetPid });

      try {
        if (owned.platform === "windows") {
          const result = this.dependencies.runCommand(
            "taskkill",
            ["/PID", String(owned.pid), "/T", "/F"],
            { shell: false, stdio: "ignore", windowsHide: true }
          );
          if (result.error) {
            throw result.error;
          }
          if (result.status !== 0) {
            throw new Error(`taskkill exited with status ${result.status}`);
          }
        } else {
          this.dependencies.kill(targetPid, "SIGKILL");
        }

        const exitCode = await this.waitForExit(owned, deadline);
        if (exitCode === PROCESS_EXIT_TIMEOUT) {
          throw new Error(`timed out after ${timeoutMs}ms waiting for process exit`);
        }
        await this.markExited(owned.pid, exitCode);
      } catch (error) {
        const exitAfterFailure = await Promise.race([
          owned.wait(),
          Promise.resolve(stillRunning),
        ]);
        if (exitAfterFailure !== stillRunning) {
          await this.markExited(owned.pid, exitAfterFailure);
          continue;
        }

        failures.push(
          new Error(
            `Process ${owned.pid} (${owned.label}) failed to terminate: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      }
    }

    if (failures.length > 0) {
      throw new HarnessError(
        "cleanup",
        failures.map((failure) => failure.message).join("; "),
        { cause: new AggregateError(failures, "process termination failures") }
      );
    }
  }

  public async assertNoSurvivors(): Promise<void> {
    const survivors = [...this.entries.values()]
      .filter((entry) => entry.live)
      .map(({ process }) => `${process.pid} (${process.label})`);

    if (survivors.length > 0) {
      throw new HarnessError(
        "cleanup",
        `Owned processes still running: ${survivors.join(", ")}`
      );
    }
  }

  private async waitForExit(
    owned: OwnedProcess,
    deadline: number
  ): Promise<number | null | typeof PROCESS_EXIT_TIMEOUT> {
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs === 0) {
      return PROCESS_EXIT_TIMEOUT;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        owned.wait(),
        new Promise<typeof PROCESS_EXIT_TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(PROCESS_EXIT_TIMEOUT), remainingMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private async log(
    action: "register" | "exit" | "terminate",
    owned: OwnedProcess,
    details: Record<string, unknown>
  ): Promise<void> {
    await mkdir(path.dirname(this.logPath), { recursive: true });
    await appendFile(
      this.logPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        action,
        pid: owned.pid,
        label: owned.label,
        platform: owned.platform,
        ...details,
      })}\n`,
      "utf8"
    );
  }
}
