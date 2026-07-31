import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { BuildArtifacts } from "../src/build-cache.js";
import type { CommandResult, CommandRunner, CommandSpec } from "../src/command.js";
import type { OwnedProcess } from "../src/process-ledger.js";
import { BrowserDriver } from "../src/drivers/browser.js";
import { HarnessError } from "../src/types.js";
import {
  RuntimeSupervisor,
  type RuntimeSupervisorDependencies,
  type RuntimeSupervisorOptions,
  type SpawnProcessSpec,
} from "../src/runtime-supervisor.js";

function makeWorkspace(name: string): string {
  const workspace = resolve(
    import.meta.dir,
    "..",
    ".test-workspace",
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

function buildArtifacts(root: string): BuildArtifacts {
  return {
    clientPath: join(root, "bin", "climon"),
    serverPath: join(root, "bin", "climon-server"),
    fixturePath: join(root, "bin", "climon-harness-fixture"),
    revision: "abc123",
    manifestPath: join(root, "build", "manifest.json"),
  };
}

function runtimeOptions(workspace: string, overrides: Partial<RuntimeSupervisorOptions> = {}): RuntimeSupervisorOptions {
  const root = join(workspace, "repo");
  mkdirSync(root, { recursive: true });

  return {
    root,
    darId: "DAR-01",
    artifactRoot: join(workspace, "artifacts"),
    platform: "linux",
    build: buildArtifacts(root),
    runner: new FakeCommandRunner(),
    startupTimeoutMs: 1_000,
    cleanupTimeoutMs: 1_000,
    ...overrides,
  };
}

class FakeCommandRunner implements CommandRunner {
  public readonly calls: CommandSpec[] = [];

  public constructor(
    private readonly onRun: (spec: CommandSpec) => CommandResult | Promise<CommandResult> = () => ({
      code: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
    })
  ) {}

  public async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec);
    return this.onRun(spec);
  }
}

function controlledProcess(
  values: Omit<OwnedProcess, "wait">
): { process: OwnedProcess; exit(code: number | null): void } {
  let resolveExit!: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });

  return {
    process: {
      ...values,
      wait: () => exitPromise,
    },
    exit: resolveExit,
  };
}

function readyBrowser(log: string[] = []) {
  let newPageCalls = 0;
  let newContextCalls = 0;
  const tracing = {
    startCalls: [] as unknown[],
    stopCalls: [] as unknown[],
    stopErrors: [] as unknown[],
    async start(options: unknown) {
      this.startCalls.push(options);
      log.push("trace:start");
    },
    async stop(options: unknown) {
      this.stopCalls.push(options);
      log.push(`trace:stop:${String((options as { path?: string }).path ?? "")}`);
      const error = this.stopErrors.shift();
      if (error !== undefined) {
        throw error;
      }
    },
  };
  const page = {
    locator(selector: string) {
      return {
        async waitFor() {
          log.push(`wait:${selector}`);
        },
      };
    },
    async goto(url: string) {
      log.push(`goto:${url}`);
    },
    on() {},
    keyboard: {
      async insertText() {},
      async press() {},
    },
    async close() {
      log.push("page-close");
    },
  } as unknown as Page;
  const context = {
    tracing,
    get newPageCalls() {
      return newPageCalls;
    },
    async newPage() {
      newPageCalls += 1;
      return page;
    },
    async close() {
      log.push("context-close");
    },
  } as unknown as BrowserContext & { newPageCalls: number };
  const browser = {
    get newContextCalls() {
      return newContextCalls;
    },
    async newContext() {
      newContextCalls += 1;
      return context;
    },
    async close() {
      log.push("browser-close");
    },
  } as unknown as Browser & { newContextCalls: number };

  return { browser, context, page, tracing };
}

async function createReadySupervisor(
  options: RuntimeSupervisorOptions,
  overrides: Partial<RuntimeSupervisorDependencies> = {}
) {
  const server = controlledProcess({
    pid: 4123,
    label: "dashboard-server",
    platform: options.platform,
    processGroup: options.platform === "windows" ? undefined : 4123,
  });
  const spawnCalls: SpawnProcessSpec[] = [];
  const fetchCalls: string[] = [];
  const { browser, context, page } = readyBrowser();
  const dependencies: RuntimeSupervisorDependencies = {
    spawnProcess: async (spec) => {
      spawnCalls.push(spec);
      mkdirSync(spec.env.CLIMON_HOME!, { recursive: true });
      writeFileSync(
        join(spec.env.CLIMON_HOME!, "server.json"),
        `${JSON.stringify({ pid: server.process.pid, port: 43123 })}\n`
      );
      return server.process;
    },
    fetch: async (input) => {
      fetchCalls.push(String(input));
      return {
        ok: true,
        json: async () => ({ ok: true }),
      } as Response;
    },
    launchBrowser: async () => browser,
    processLedgerDependencies: {
      server: {
        kill() {
          server.exit(0);
        },
      },
    },
    ...overrides,
  };

  const supervisor = await RuntimeSupervisor.create(options, dependencies);
  return { supervisor, server, spawnCalls, fetchCalls, browser, context, page };
}

async function startBrowserTrace(baseUrl: string, context: BrowserContext, page: Page): Promise<void> {
  const driver = new BrowserDriver(
    { context, page },
    {
      now: () => 0,
      sleep: async () => {},
      pollIntervalMs: 1,
    }
  );

  await driver.open(baseUrl, 1_000);
}

function withEnv<T>(entries: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return fn().finally(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

describe("RuntimeSupervisor.create", () => {
  test("initializes an isolated DAR runtime with exact env, config, server startup, and one browser context/page", async () => {
    const workspace = makeWorkspace("runtime-supervisor-create");
    const options = runtimeOptions(workspace);

    try {
      const { supervisor, spawnCalls, fetchCalls, browser, context, page } =
        await createReadySupervisor(options);

      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]).toMatchObject({
        file: options.build.serverPath,
        args: ["server", "--no-takeover", "--port", "0"],
        cwd: options.root,
        shell: false,
        label: "climon-server",
        platform: "linux",
      });
      expect(spawnCalls[0].env.CLIMON_CLIENT_BIN).toBe(options.build.clientPath);
      expect(spawnCalls[0].env.CLIMON_HOME).toBe(supervisor.context.home);
      expect(spawnCalls[0].env.CLIMON_SESSION_ENGINE).toBe("actor");
      expect(spawnCalls[0].env.CLIMON_COLS).toBe("100");
      expect(spawnCalls[0].env.CLIMON_ROWS).toBe("30");
      expect(spawnCalls[0].env.CI).toBe("true");
      expect(spawnCalls[0].env.NO_COLOR).toBe("1");
      expect(spawnCalls[0].env.CLIMON_DISABLE_SETSID).toBeUndefined();

      expect(supervisor.context.root).toBe(options.root);
      expect(supervisor.context.home).toBe(
        join(options.artifactRoot, "cases", "DAR-01", "temp", "h")
      );
      expect(supervisor.context.baseUrl).toBe("http://127.0.0.1:43123/");
      expect(supervisor.context.artifacts.dir).toBe(
        join(options.artifactRoot, "cases", "DAR-01")
      );
      expect(supervisor.context.browser).toBe(browser);
      expect(supervisor.context.context).toBe(context);
      expect(supervisor.context.page).toBe(page);

      expect(fetchCalls).toEqual(["http://127.0.0.1:43123/health"]);
      expect(browser.newContextCalls).toBe(1);
      expect(context.newPageCalls).toBe(1);

      expect(
        JSON.parse(readFileSync(join(supervisor.context.home, "config.jsonc"), "utf8"))
      ).toEqual({
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
      });

      await supervisor.dispose();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("creates unique isolated homes for different DAR cases", async () => {
    const workspace = makeWorkspace("runtime-supervisor-homes");
    const firstOptions = runtimeOptions(workspace, { darId: "DAR-01" });
    const secondOptions = runtimeOptions(workspace, { darId: "DAR-02" });

    try {
      const first = await createReadySupervisor(firstOptions);
      const second = await createReadySupervisor(secondOptions);

      expect(first.supervisor.context.home).not.toBe(second.supervisor.context.home);
      expect(first.supervisor.context.home).toBe(
        join(firstOptions.artifactRoot, "cases", "DAR-01", "temp", "h")
      );
      expect(second.supervisor.context.home).toBe(
        join(secondOptions.artifactRoot, "cases", "DAR-02", "temp", "h")
      );

      await first.supervisor.dispose();
      await second.supervisor.dispose();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("preserves CLIMON_DISABLE_SETSID only for Linux CI", async () => {
    const workspace = makeWorkspace("runtime-supervisor-setsid");

    try {
      await withEnv({ CI: undefined, CLIMON_DISABLE_SETSID: "1" }, async () => {
        const localLinux = await createReadySupervisor(runtimeOptions(workspace), {
          processLedgerDependencies: {
            server: {
              kill() {},
            },
          },
        });
        expect(localLinux.spawnCalls[0].env.CLIMON_DISABLE_SETSID).toBeUndefined();
        localLinux.server.exit(0);
        await localLinux.supervisor.dispose();
      });

      await withEnv({ CI: "true", CLIMON_DISABLE_SETSID: "1" }, async () => {
        const linux = await createReadySupervisor(runtimeOptions(workspace));
        const macos = await createReadySupervisor(
          runtimeOptions(workspace, { darId: "DAR-02", platform: "macos" })
        );

        expect(linux.spawnCalls[0].env.CLIMON_DISABLE_SETSID).toBe("1");
        expect(macos.spawnCalls[0].env.CLIMON_DISABLE_SETSID).toBeUndefined();

        await linux.supervisor.dispose();
        await macos.supervisor.dispose();
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("fails startup when server.json does not match the spawned server pid", async () => {
    const workspace = makeWorkspace("runtime-supervisor-pid-mismatch");
    const options = runtimeOptions(workspace);
    const server = controlledProcess({
      pid: 5001,
      label: "dashboard-server",
      platform: "linux",
      processGroup: 5001,
    });
    const fetchCalls: string[] = [];
    let terminated = false;

    try {
      await expect(
        RuntimeSupervisor.create(options, {
          spawnProcess: async (spec) => {
            mkdirSync(spec.env.CLIMON_HOME!, { recursive: true });
            writeFileSync(
              join(spec.env.CLIMON_HOME!, "server.json"),
              `${JSON.stringify({ pid: 9999, port: 43123 })}\n`
            );
            return server.process;
          },
          fetch: async (input) => {
            fetchCalls.push(String(input));
            return {
              ok: true,
              json: async () => ({ ok: true }),
            } as Response;
          },
          launchBrowser: async () => readyBrowser().browser,
          processLedgerDependencies: {
            server: {
              kill() {
                terminated = true;
                server.exit(0);
              },
            },
          },
        })
      ).rejects.toEqual(
        expect.objectContaining({
          name: "HarnessError",
          kind: "server-startup",
          message: expect.stringContaining("pid"),
        })
      );
      expect(fetchCalls).toEqual([]);
      expect(terminated).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("fails immediately when the server exits before server.json becomes ready", async () => {
    const workspace = makeWorkspace("runtime-supervisor-early-exit");
    const options = runtimeOptions(workspace, {
      startupTimeoutMs: 30_000,
    });
    const sleepCalls: number[] = [];
    let fetchCalled = false;
    let browserLaunched = false;
    let serverKillAttempts = 0;
    const server: OwnedProcess = {
      pid: 5003,
      label: "dashboard-server",
      platform: "linux",
      processGroup: 5003,
      wait: async () => 23,
    };

    try {
      const error = await RuntimeSupervisor.create(options, {
        now: () => 1_000,
        sleep: async (ms) => {
          sleepCalls.push(ms);
          throw new Error(`sleep should not be called: ${ms}`);
        },
        spawnProcess: async (spec) => {
          mkdirSync(spec.env.CLIMON_HOME!, { recursive: true });
          return server;
        },
        fetch: async () => {
          fetchCalled = true;
          return {
            ok: true,
            json: async () => ({ ok: true }),
          } as Response;
        },
        launchBrowser: async () => {
          browserLaunched = true;
          return readyBrowser().browser;
        },
        processLedgerDependencies: {
          server: {
            kill() {
              serverKillAttempts += 1;
            },
          },
        },
      }).catch((caught: unknown) => caught);

      expect(error).toEqual(
        expect.objectContaining({
          name: "HarnessError",
          kind: "server-startup",
        })
      );
      expect((error as Error).message).toContain("exited with code 23");
      expect((error as Error).message).toContain(
        join(options.artifactRoot, "cases", "DAR-01", "logs", "server.stdout.log")
      );
      expect((error as Error).message).toContain(
        join(options.artifactRoot, "cases", "DAR-01", "logs", "server.stderr.log")
      );
      expect(sleepCalls).toEqual([]);
      expect(fetchCalled).toBe(false);
      expect(browserLaunched).toBe(false);
      expect(serverKillAttempts).toBe(0);

      expect(
        readFileSync(
          join(options.artifactRoot, "cases", "DAR-01", "server", "process-ledger.jsonl"),
          "utf8"
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).action)
      ).toEqual(["register", "exit"]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("keeps the owned process wait receiver intact while observing startup", async () => {
    const workspace = makeWorkspace("runtime-supervisor-wait-binding");
    const options = runtimeOptions(workspace);
    let resolveExit!: (code: number | null) => void;
    const exitPromise = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    const { browser } = readyBrowser();

    try {
      let owned:
        | (OwnedProcess & {
            exitPromise: Promise<number | null>;
          })
        | undefined;
      const supervisor = await RuntimeSupervisor.create(options, {
        spawnProcess: async (spec) => {
          mkdirSync(spec.env.CLIMON_HOME!, { recursive: true });
          writeFileSync(
            join(spec.env.CLIMON_HOME!, "server.json"),
            `${JSON.stringify({ pid: 5004, port: 43123 })}\n`
          );
          owned = {
            pid: 5004,
            label: "dashboard-server",
            platform: "linux",
            processGroup: 5004,
            exitPromise,
            wait() {
              if (this !== owned) {
                throw new Error("wait receiver lost");
              }
              return this.exitPromise;
            },
          } as OwnedProcess & { exitPromise: Promise<number | null> };
          return owned;
        },
        fetch: async () =>
          ({
            ok: true,
            json: async () => ({ ok: true }),
          }) as Response,
        launchBrowser: async () => browser,
        processLedgerDependencies: {
          server: {
            kill() {
              resolveExit(0);
            },
          },
        },
      });

      await supervisor.dispose();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("closes the browser and context when page creation fails", async () => {
    const workspace = makeWorkspace("runtime-supervisor-page-failure");
    const options = runtimeOptions(workspace);
    const server = controlledProcess({
      pid: 5002,
      label: "dashboard-server",
      platform: "linux",
      processGroup: 5002,
    });
    const closed: string[] = [];
    const pageFailure = new Error("page failed");
    const context = {
      async newPage() {
        throw pageFailure;
      },
      async close() {
        closed.push("context");
      },
    } as unknown as BrowserContext;
    const browser = {
      async newContext() {
        return context;
      },
      async close() {
        closed.push("browser");
      },
    } as unknown as Browser;

    try {
      const error = await RuntimeSupervisor.create(options, {
        spawnProcess: async (spec) => {
          mkdirSync(spec.env.CLIMON_HOME!, { recursive: true });
          writeFileSync(
            join(spec.env.CLIMON_HOME!, "server.json"),
            `${JSON.stringify({ pid: server.process.pid, port: 43123 })}\n`
          );
          return server.process;
        },
        fetch: async () =>
          ({
            ok: true,
            json: async () => ({ ok: true }),
          }) as Response,
        launchBrowser: async () => browser,
        processLedgerDependencies: {
          server: {
            kill() {
              server.exit(0);
            },
          },
        },
      }).catch((caught: unknown) => caught);

      expect(error).toBe(pageFailure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("page failed");
      expect(closed).toEqual(["context", "browser"]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("surfaces startup cleanup failures when page creation and server termination both fail", async () => {
    const workspace = makeWorkspace("runtime-supervisor-startup-cleanup-failure");
    const options = runtimeOptions(workspace);
    const server = controlledProcess({
      pid: 5005,
      label: "dashboard-server",
      platform: "linux",
      processGroup: 5005,
    });
    const log: string[] = [];
    const pageFailure = new Error("page failed");
    const contextCloseFailure = new Error("context close failed");
    const browserCloseFailure = new Error("browser close failed");
    const terminationFailure = new Error("server stuck");
    const context = {
      async newPage() {
        throw pageFailure;
      },
      async close() {
        log.push("context-close");
        throw contextCloseFailure;
      },
    } as unknown as BrowserContext;
    const browser = {
      async newContext() {
        return context;
      },
      async close() {
        log.push("browser-close");
        throw browserCloseFailure;
      },
    } as unknown as Browser;

    try {
      const error = await RuntimeSupervisor.create(options, {
        spawnProcess: async (spec) => {
          mkdirSync(spec.env.CLIMON_HOME!, { recursive: true });
          writeFileSync(
            join(spec.env.CLIMON_HOME!, "server.json"),
            `${JSON.stringify({ pid: server.process.pid, port: 43123 })}\n`
          );
          return server.process;
        },
        fetch: async () =>
          ({
            ok: true,
            json: async () => ({ ok: true }),
          }) as Response,
        launchBrowser: async () => browser,
        processLedgerDependencies: {
          server: {
            kill() {
              log.push("server-terminate");
              throw terminationFailure;
            },
          },
        },
      }).catch((caught: unknown) => caught);

      expect(log).toHaveLength(3);
      expect(log).toContain("context-close");
      expect(log).toContain("server-terminate");
      expect(log).toContain("browser-close");
      expect(error).toBeInstanceOf(HarnessError);
      expect(error).toEqual(
        expect.objectContaining({
          name: "HarnessError",
          kind: "cleanup",
          cause: expect.any(AggregateError),
        })
      );
      expect(error).not.toBe(pageFailure);
      expect((error as Error).message).toContain("page failed");
      expect((error as Error).message).toContain("server stuck");
      expect((error as Error).message).toContain("Owned processes still running");
      expect((error as Error).message).toContain("context close failed");
      expect((error as Error).message).toContain("browser close failed");

      const aggregateCause = (error as HarnessError).cause as AggregateError;
      const aggregateMessages = Array.from(aggregateCause.errors, (entry) =>
        entry instanceof Error ? entry.message : String(entry)
      );
      expect(aggregateMessages).toContain("page failed");
      expect(aggregateMessages).toContain("context close failed");
      expect(aggregateMessages).toContain("browser close failed");
      expect(
        aggregateMessages.some((message) => message.includes("server stuck"))
      ).toBe(true);
      expect(
        aggregateMessages.some((message) => message.includes("Owned processes still running"))
      ).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("RuntimeSupervisor.dispose", () => {
  test("attempts every cleanup phase, kills tracked sessions before the server, snapshots home, and aggregates failures", async () => {
    const workspace = makeWorkspace("runtime-supervisor-dispose");
    const log: string[] = [];
    const runner = new FakeCommandRunner((spec) => {
      log.push(`kill:${spec.args.at(-1)}`);
      return {
        code: 9,
        stdout: "",
        stderr: "kill failed",
        durationMs: 1,
      };
    });
    const options = runtimeOptions(workspace, {
      runner,
      cleanupTimeoutMs: 0,
    });
    const server = controlledProcess({
      pid: 6123,
      label: "dashboard-server",
      platform: "linux",
      processGroup: 6123,
    });
    const client = controlledProcess({
      pid: 7123,
      label: "fixture-client",
      platform: "linux",
      processGroup: 7123,
    });
    const browser = {
      async newContext() {
        return {
          async newPage() {
            return {
              async close() {
                log.push("page-close");
                throw new Error("page close failed");
              },
            };
          },
          async close() {
            log.push("context-close");
            throw new Error("context close failed");
          },
        };
      },
      async close() {
        log.push("browser-close");
        throw new Error("browser close failed");
      },
    } as unknown as Browser;

    try {
      const supervisor = await RuntimeSupervisor.create(options, {
        now: () => 1_000,
        sleep: async () => {
          throw new Error("sleep should not be called");
        },
        spawnProcess: async (spec) => {
          mkdirSync(spec.env.CLIMON_HOME!, { recursive: true });
          writeFileSync(
            join(spec.env.CLIMON_HOME!, "server.json"),
            `${JSON.stringify({ pid: server.process.pid, port: 43123 })}\n`
          );
          return server.process;
        },
        fetch: async () => {
          return {
            ok: true,
            json: async () => ({ ok: true }),
          } as Response;
        },
        launchBrowser: async () => browser,
        processLedgerDependencies: {
          client: {
            kill() {
              log.push("client-terminate");
              throw new Error("client stuck");
            },
          },
          server: {
            kill() {
              log.push("server-terminate");
              server.exit(0);
            },
          },
        },
      });

      supervisor.context.sessions.track("session-1");
      mkdirSync(join(supervisor.context.home, "sessions"), { recursive: true });
      writeFileSync(
        join(supervisor.context.home, "sessions", "session-1.json"),
        `${JSON.stringify({ id: "session-1", status: "running" })}\n`
      );
      await supervisor.context.processes.register(client.process);

      const error = await supervisor.dispose().catch((caught: unknown) => caught);

      expect(log).toEqual([
        "page-close",
        "context-close",
        "kill:session-1",
        "client-terminate",
        "server-terminate",
        "browser-close",
      ]);
      expect(readFileSync(join(supervisor.context.artifacts.dir, "home", "config.jsonc"), "utf8"))
        .toContain('"telemetry"');
      expect(error).toEqual(
        expect.objectContaining({
          name: "HarnessError",
          kind: "cleanup",
          message: expect.stringContaining("session-1"),
          cause: expect.any(AggregateError),
        })
      );
      expect((error as Error).message).toContain("page close failed");
      expect((error as Error).message).toContain("context close failed");
      expect((error as Error).message).toContain("client stuck");
      expect((error as Error).message).toContain("Owned processes still running");
      expect((error as Error).message).toContain("browser close failed");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("stops and saves the browser trace before closing the page and context", async () => {
    const workspace = makeWorkspace("runtime-supervisor-dispose-trace");
    const log: string[] = [];
    const options = runtimeOptions(workspace);
    const fakeBrowser = readyBrowser(log);

    try {
      const { supervisor } = await createReadySupervisor(options, {
        launchBrowser: async () => fakeBrowser.browser,
      });
      const tracePath = join(supervisor.context.artifacts.dir, "browser-trace.zip");

      await startBrowserTrace(
        supervisor.context.baseUrl,
        supervisor.context.context,
        supervisor.context.page
      );
      await supervisor.dispose();

      expect(fakeBrowser.tracing.stopCalls).toEqual([{ path: tracePath }]);
      expect(log.indexOf(`trace:stop:${tracePath}`)).toBeGreaterThan(-1);
      expect(log.indexOf(`trace:stop:${tracePath}`)).toBeLessThan(log.indexOf("page-close"));
      expect(log.indexOf("page-close")).toBeLessThan(log.indexOf("context-close"));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("retries failed trace cleanup without rerunning successful later phases", async () => {
    const workspace = makeWorkspace("runtime-supervisor-dispose-trace-retry");
    const log: string[] = [];
    const options = runtimeOptions(workspace);
    const fakeBrowser = readyBrowser(log);
    fakeBrowser.tracing.stopErrors.push(new Error("trace stop failed"));

    try {
      const { supervisor } = await createReadySupervisor(options, {
        launchBrowser: async () => fakeBrowser.browser,
      });
      const tracePath = join(supervisor.context.artifacts.dir, "browser-trace.zip");
      const serverLedgerPath = join(
        supervisor.context.artifacts.dir,
        "server",
        "process-ledger.jsonl"
      );

      await startBrowserTrace(
        supervisor.context.baseUrl,
        supervisor.context.context,
        supervisor.context.page
      );

      const firstError = await supervisor.dispose().catch((caught: unknown) => caught);
      expect(firstError).toEqual(
        expect.objectContaining({
          name: "HarnessError",
          kind: "cleanup",
          cause: expect.any(AggregateError),
        })
      );
      expect((firstError as Error).message).toContain("trace stop failed");
      expect(log).toContain(`trace:stop:${tracePath}`);
      expect(log).not.toContain("page-close");
      expect(log).not.toContain("context-close");
      expect(log).not.toContain("browser-close");
      expect(
        readFileSync(serverLedgerPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).action)
          .filter((action) => action === "terminate")
      ).toHaveLength(1);

      await expect(supervisor.dispose()).resolves.toBeUndefined();

      expect(fakeBrowser.tracing.stopCalls).toEqual([{ path: tracePath }, { path: tracePath }]);
      expect(log.lastIndexOf(`trace:stop:${tracePath}`)).toBeLessThan(log.indexOf("page-close"));
      expect(log).toContain("page-close");
      expect(log).toContain("context-close");
      expect(log).toContain("browser-close");
      expect(
        readFileSync(serverLedgerPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).action)
          .filter((action) => action === "terminate")
      ).toHaveLength(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("retries unfinished cleanup on a later dispose without rerunning completed phases", async () => {
    const workspace = makeWorkspace("runtime-supervisor-dispose-retry");
    const log: string[] = [];
    let sessionPath = "";
    let clientTerminateAttempts = 0;
    let serverTerminateAttempts = 0;
    const runner = new FakeCommandRunner((spec) => {
      log.push(`kill:${spec.args.at(-1)}`);
      writeFileSync(
        sessionPath,
        `${JSON.stringify({ id: "session-1", status: "completed", exitCode: 0 })}\n`
      );
      return {
        code: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
      };
    });
    const options = runtimeOptions(workspace, {
      runner,
      cleanupTimeoutMs: 0,
    });
    const server = controlledProcess({
      pid: 6124,
      label: "dashboard-server",
      platform: "linux",
      processGroup: 6124,
    });
    const client = controlledProcess({
      pid: 7124,
      label: "fixture-client",
      platform: "linux",
      processGroup: 7124,
    });
    const browser = {
      async newContext() {
        return {
          async newPage() {
            return {
              async close() {
                log.push("page-close");
              },
            };
          },
          async close() {
            log.push("context-close");
          },
        };
      },
      async close() {
        log.push("browser-close");
      },
    } as unknown as Browser;

    try {
      const supervisor = await RuntimeSupervisor.create(options, {
        now: () => 1_000,
        sleep: async () => {
          throw new Error("sleep should not be called");
        },
        spawnProcess: async (spec) => {
          mkdirSync(spec.env.CLIMON_HOME!, { recursive: true });
          writeFileSync(
            join(spec.env.CLIMON_HOME!, "server.json"),
            `${JSON.stringify({ pid: server.process.pid, port: 43123 })}\n`
          );
          return server.process;
        },
        fetch: async () =>
          ({
            ok: true,
            json: async () => ({ ok: true }),
          }) as Response,
        launchBrowser: async () => browser,
        processLedgerDependencies: {
          client: {
            kill() {
              clientTerminateAttempts += 1;
              log.push(`client-terminate-${clientTerminateAttempts}`);
              if (clientTerminateAttempts === 1) {
                throw new Error("client stuck");
              }
              client.exit(0);
            },
          },
          server: {
            kill() {
              serverTerminateAttempts += 1;
              log.push(`server-terminate-${serverTerminateAttempts}`);
              server.exit(0);
            },
          },
        },
      });

      supervisor.context.sessions.track("session-1");
      mkdirSync(join(supervisor.context.home, "sessions"), { recursive: true });
      sessionPath = join(supervisor.context.home, "sessions", "session-1.json");
      writeFileSync(sessionPath, `${JSON.stringify({ id: "session-1", status: "running" })}\n`);
      await supervisor.context.processes.register(client.process);

      const firstError = await supervisor.dispose().catch((caught: unknown) => caught);

      expect(firstError).toEqual(
        expect.objectContaining({
          name: "HarnessError",
          kind: "cleanup",
          cause: expect.any(AggregateError),
        })
      );
      expect((firstError as Error).message).toContain("client stuck");
      expect((firstError as Error).message).toContain("Owned processes still running");

      await expect(supervisor.dispose()).resolves.toBeUndefined();
      await expect(supervisor.context.processes.assertNoSurvivors()).resolves.toBeUndefined();

      expect(log).toEqual([
        "page-close",
        "context-close",
        "kill:session-1",
        "client-terminate-1",
        "server-terminate-1",
        "browser-close",
        "client-terminate-2",
      ]);
      expect(runner.calls).toHaveLength(1);
      expect(clientTerminateAttempts).toBe(2);
      expect(serverTerminateAttempts).toBe(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("does not retry page close after context close already finished that phase", async () => {
    const workspace = makeWorkspace("runtime-supervisor-dispose-page-retry");
    const log: string[] = [];
    let pageCloseAttempts = 0;
    const options = runtimeOptions(workspace);
    const server = controlledProcess({
      pid: 6125,
      label: "dashboard-server",
      platform: "linux",
      processGroup: 6125,
    });
    const browser = {
      async newContext() {
        return {
          async newPage() {
            return {
              async close() {
                pageCloseAttempts += 1;
                log.push(`page-close-${pageCloseAttempts}`);
                throw new Error("page close failed");
              },
            };
          },
          async close() {
            log.push("context-close");
          },
        };
      },
      async close() {
        log.push("browser-close");
      },
    } as unknown as Browser;

    try {
      const supervisor = await RuntimeSupervisor.create(options, {
        now: () => 1_000,
        sleep: async () => {
          throw new Error("sleep should not be called");
        },
        spawnProcess: async (spec) => {
          mkdirSync(spec.env.CLIMON_HOME!, { recursive: true });
          writeFileSync(
            join(spec.env.CLIMON_HOME!, "server.json"),
            `${JSON.stringify({ pid: server.process.pid, port: 43123 })}\n`
          );
          return server.process;
        },
        fetch: async () =>
          ({
            ok: true,
            json: async () => ({ ok: true }),
          }) as Response,
        launchBrowser: async () => browser,
        processLedgerDependencies: {
          server: {
            kill() {
              server.exit(0);
            },
          },
        },
      });

      const firstError = await supervisor.dispose().catch((caught: unknown) => caught);
      expect(firstError).toEqual(
        expect.objectContaining({
          name: "HarnessError",
          kind: "cleanup",
        })
      );

      await expect(supervisor.dispose()).resolves.toBeUndefined();
      expect(log).toEqual(["page-close-1", "context-close", "browser-close"]);
      expect(pageCloseAttempts).toBe(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
