import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join, resolve } from "node:path";

const launcherModule = await import("../src/launcher.js").catch(() => null);
const buildHarnessNodeBundle = (
  launcherModule as { buildHarnessNodeBundle?: (root: string, dependencies?: Record<string, unknown>) => Promise<string> } | null
)?.buildHarnessNodeBundle;
const runHarnessLauncher = (
  launcherModule as { runHarnessLauncher?: (args: string[], options?: Record<string, unknown>) => Promise<number> } | null
)?.runHarnessLauncher;

const REPOSITORY_ROOT = resolve(import.meta.dir, "..", "..");

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

function requireBuildHarnessNodeBundle(): NonNullable<typeof buildHarnessNodeBundle> {
  expect(buildHarnessNodeBundle).toBeDefined();
  return buildHarnessNodeBundle!;
}

function requireRunHarnessLauncher(): NonNullable<typeof runHarnessLauncher> {
  expect(runHarnessLauncher).toBeDefined();
  return runHarnessLauncher!;
}

describe("harness launcher", () => {
  test("routes bun run harness through the Bun launcher script", () => {
    const packageJson = JSON.parse(
      readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.harness).toBe("bun harness/src/launcher.ts");
  });

  test("bundles the harness CLI for Node into the tooling cache", async () => {
    const build = requireBuildHarnessNodeBundle();
    const root = makeWorkspace("launcher-build");
    const calls: Array<Record<string, unknown>> = [];
    const writes: Array<{ path: string; text: string; encoding: string }> = [];

    try {
      const outputPath = await build(root, {
        build: async (options: Record<string, unknown>) => {
          calls.push(options);
          return {
            success: true,
            logs: [],
            outputs: [
              {
                kind: "entry-point",
                text() {
                  return "console.log('node harness');";
                },
              },
            ],
          };
        },
        writeFile: async (path: string, text: string, encoding: string) => {
          writes.push({ path, text, encoding });
        },
      });

      expect(outputPath).toBe(
        join(root, ".test-tmp", "e2e-harness", "tooling", "harness-node.mjs")
      );
      expect(calls).toEqual([
        {
          entrypoints: [join(root, "harness", "src", "main.ts")],
          target: "node",
          format: "esm",
          packages: "external",
        },
      ]);
      expect(writes).toEqual([
        {
          path: join(root, ".test-tmp", "e2e-harness", "tooling", "harness-node.mjs"),
          text: "console.log('node harness');",
          encoding: "utf8",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("spawns Node without a shell, inherits stdio, and forwards signals", async () => {
    const run = requireRunHarnessLauncher();
    const root = "/repo";
    const processListeners = new Map<string, (signal: NodeJS.Signals) => void>();
    const childListeners = new Map<string, (...args: unknown[]) => void>();
    const killSignals: NodeJS.Signals[] = [];
    const processOffCalls: string[] = [];
    const stderrWrites: string[] = [];
    const spawnCalls: Array<Record<string, unknown>> = [];

    const launch = run(["doctor", "--flag"], {
      root,
      buildNodeBundle: async () =>
        join(root, ".test-tmp", "e2e-harness", "tooling", "harness-node.mjs"),
      spawnChild: (
        file: string,
        args: string[],
        options: Record<string, unknown>
      ) => {
        spawnCalls.push({ file, args, options });
        return {
          on(event: string, listener: (...listenerArgs: unknown[]) => void) {
            childListeners.set(event, listener);
            return this;
          },
          kill(signal?: NodeJS.Signals) {
            if (signal) {
              killSignals.push(signal);
            }
            return true;
          },
        };
      },
      processApi: {
        env: { PATH: "/usr/bin", HOME: "/home/tester" },
        on(event: string, listener: (signal: NodeJS.Signals) => void) {
          processListeners.set(event, listener);
        },
        off(event: string) {
          processOffCalls.push(event);
        },
        stderr: {
          write(chunk: string) {
            stderrWrites.push(chunk);
          },
        },
      },
    });

    await Promise.resolve();
    processListeners.get("SIGINT")?.("SIGINT");
    expect(killSignals).toEqual(["SIGINT"]);

    childListeners.get("exit")?.(0, null);

    await expect(launch).resolves.toBe(0);
    expect(spawnCalls).toEqual([
      {
        file: "node",
        args: [
          join(root, ".test-tmp", "e2e-harness", "tooling", "harness-node.mjs"),
          "doctor",
          "--flag",
        ],
        options: {
          cwd: root,
          env: {
            PATH: "/usr/bin",
            HOME: "/home/tester",
            CLIMON_HARNESS_ROOT: root,
          },
          shell: false,
          stdio: "inherit",
        },
      },
    ]);
    expect(processOffCalls).toEqual(["SIGINT", "SIGTERM"]);
    expect(stderrWrites).toEqual([]);
  });

  test("mirrors signal exits with the conventional 128+signal status", async () => {
    const run = requireRunHarnessLauncher();
    const root = "/repo";
    const childListeners = new Map<string, (...args: unknown[]) => void>();

    const launch = run([], {
      root,
      buildNodeBundle: async () =>
        join(root, ".test-tmp", "e2e-harness", "tooling", "harness-node.mjs"),
      spawnChild: () => ({
        on(event: string, listener: (...listenerArgs: unknown[]) => void) {
          childListeners.set(event, listener);
          return this;
        },
        kill() {
          return true;
        },
      }),
      processApi: {
        env: {},
        on() {},
        off() {},
        stderr: { write() {} },
      },
    });

    await Promise.resolve();
    childListeners.get("exit")?.(null, "SIGTERM");

    await expect(launch).resolves.toBe(128 + osConstants.signals.SIGTERM);
  });

  test("builds a Node bundle that imports cleanly under Node ESM", async () => {
    const build = requireBuildHarnessNodeBundle();
    const bundlePath = await build(REPOSITORY_ROOT);
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        "import { pathToFileURL } from 'node:url'; await import(pathToFileURL(process.argv[2]).href);",
        "eval-driver.mjs",
        bundlePath,
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: process.env,
        encoding: "utf8",
      }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
