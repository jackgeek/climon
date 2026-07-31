import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildArtifacts, planBuild } from "../src/build-cache.js";
import type { CommandResult, CommandRunner, CommandSpec } from "../src/command.js";
import { HarnessError, type HarnessPlatform } from "../src/types.js";

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

function clientArtifactPath(root: string, platform: HarnessPlatform): string {
  const suffix = platform === "windows" ? ".exe" : "";
  return join(root, "rust", "target", "release", `climon${suffix}`);
}

function fixtureArtifactPath(root: string, platform: HarnessPlatform): string {
  const suffix = platform === "windows" ? ".exe" : "";
  return join(
    root,
    "harness",
    "fixtures",
    "target",
    "release",
    `climon-harness-fixture${suffix}`
  );
}

function serverArtifactPath(cacheDir: string, platform: HarnessPlatform): string {
  const suffix = platform === "windows" ? ".exe" : "";
  return join(cacheDir, `climon-server${suffix}`);
}

function expectedArtifacts(
  root: string,
  cacheDir: string,
  platform: HarnessPlatform,
  revision: string
) {
  return {
    clientPath: clientArtifactPath(root, platform),
    serverPath: serverArtifactPath(cacheDir, platform),
    fixturePath: fixtureArtifactPath(root, platform),
    revision,
    manifestPath: join(cacheDir, "manifest.json"),
  };
}

function toolVersions() {
  return {
    bun: "1.3.10",
    node: "24.0.0",
    rust: "1.89.0",
    playwright: "1.62.1",
    chromium: "151.0.7922.34",
  };
}

function buildDependencies(revision: string, architecture: string, overrides = {}) {
  return {
    architecture,
    readRevision: async () => revision,
    readToolVersions: async () => toolVersions(),
    isWorktreeClean: async () => true,
    ...overrides,
  };
}

function describeCommand(command: CommandSpec) {
  const { file, args, cwd, timeoutMs, stdoutPath, stderrPath } = command;
  return { file, args, cwd, timeoutMs, stdoutPath, stderrPath };
}

class FakeCommandRunner implements CommandRunner {
  public readonly calls: CommandSpec[] = [];

  public constructor(private readonly onRun: (spec: CommandSpec) => void) {}

  public async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec);
    this.onRun(spec);
    return {
      code: 0,
      stdout: `built ${spec.file}`,
      stderr: "",
      durationMs: 5,
    };
  }
}

describe("planBuild", () => {
  test("returns the approved release build plan for Windows hosts", () => {
    const plan = planBuild("/repo", "/cache", "windows");

    expect({
      clientPath: plan.clientPath,
      serverPath: plan.serverPath,
      fixturePath: plan.fixturePath,
      client: describeCommand(plan.client),
      server: describeCommand(plan.server),
      fixture: describeCommand(plan.fixture),
    }).toEqual({
      clientPath: "/repo/rust/target/release/climon.exe",
      serverPath: "/cache/climon-server.exe",
      fixturePath: "/repo/harness/fixtures/target/release/climon-harness-fixture.exe",
      client: {
        file: "cargo",
        args: ["build", "--release", "-p", "climon-cli"],
        cwd: "/repo/rust",
        timeoutMs: 600_000,
        stdoutPath: "/cache/logs/01-cargo-client.stdout.log",
        stderrPath: "/cache/logs/01-cargo-client.stderr.log",
      },
      server: {
        file: "bun",
        args: [
          "build",
          "src/server.ts",
          "--compile",
          "--define",
          "__CLIMON_EMBEDDED__=true",
          "--outfile",
          "/cache/climon-server.exe",
        ],
        cwd: "/repo",
        timeoutMs: 600_000,
        stdoutPath: "/cache/logs/02-bun-server.stdout.log",
        stderrPath: "/cache/logs/02-bun-server.stderr.log",
      },
      fixture: {
        file: "cargo",
        args: ["build", "--release", "--manifest-path", "harness/fixtures/Cargo.toml"],
        cwd: "/repo",
        timeoutMs: 600_000,
        stdoutPath: "/cache/logs/03-cargo-fixture.stdout.log",
        stderrPath: "/cache/logs/03-cargo-fixture.stderr.log",
      },
    });
    expect(Object.hasOwn(plan as object, "commands")).toBe(false);

    for (const command of [plan.client, plan.server, plan.fixture]) {
      expect(command.env.PATH).toBe(process.env.PATH);
    }
  });
});

describe("buildArtifacts", () => {
  test("builds artifacts, writes a manifest, and reuses a valid cache entry", async () => {
    const workspace = makeWorkspace("build-cache-reuse");
    const root = join(workspace, "repo");
    const cacheRoot = join(workspace, "cache");
    const platform: HarnessPlatform = "linux";
    const architecture = "x64";
    const revision = "abc123";
    const cacheDir = join(cacheRoot, revision, platform, architecture);

    mkdirSync(join(root, "rust"), { recursive: true });
    mkdirSync(join(root, "harness", "fixtures"), { recursive: true });

    const runner = new FakeCommandRunner((spec) => {
      mkdirSync(spec.cwd, { recursive: true });
      mkdirSync(dirname(spec.stdoutPath), { recursive: true });
      writeFileSync(spec.stdoutPath, `stdout:${spec.file}`);
      writeFileSync(spec.stderrPath, "");

      if (spec.file === "bun") {
        writeFileSync(serverArtifactPath(cacheDir, platform), "server-binary");
        return;
      }

      if (spec.args.includes("-p")) {
        mkdirSync(dirname(clientArtifactPath(root, platform)), { recursive: true });
        writeFileSync(clientArtifactPath(root, platform), "client-binary");
        return;
      }

      mkdirSync(dirname(fixtureArtifactPath(root, platform)), { recursive: true });
      writeFileSync(fixtureArtifactPath(root, platform), "fixture-binary");
    });

    try {
      const first = await buildArtifacts(
        { root, cacheRoot, platform, runner },
        buildDependencies(revision, architecture)
      );
      const secondRunner = new FakeCommandRunner(() => {
        throw new Error("cache reuse should not rebuild");
      });
      const second = await buildArtifacts(
        { root, cacheRoot, platform, runner: secondRunner },
        buildDependencies(revision, architecture)
      );

      expect(first).toEqual(expectedArtifacts(root, cacheDir, platform, revision));
      expect(second).toEqual(expectedArtifacts(root, cacheDir, platform, revision));
      expect(runner.calls).toHaveLength(3);
      expect(secondRunner.calls).toHaveLength(0);

      const manifest = JSON.parse(readFileSync(join(cacheDir, "manifest.json"), "utf8")) as {
        revision: string;
        platform: string;
        architecture: string;
        bun: string;
        node: string;
        rust: string;
        playwright: string;
        chromium: string;
        checksums: Record<string, string>;
        versions?: unknown;
      };

      expect(manifest).toMatchObject({
        revision,
        platform,
        architecture,
        ...toolVersions(),
      });
      expect(manifest.versions).toBeUndefined();
      expect(Object.keys(manifest.checksums).sort()).toEqual(["client", "fixture", "server"]);
      expect(statSync(join(cacheDir, "manifest.json")).isFile()).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rebuilds when an artifact checksum no longer matches the manifest", async () => {
    const workspace = makeWorkspace("build-cache-checksum");
    const root = join(workspace, "repo");
    const cacheRoot = join(workspace, "cache");
    const platform: HarnessPlatform = "linux";
    const architecture = "x64";
    const revision = "def456";
    const cacheDir = join(cacheRoot, revision, platform, architecture);

    mkdirSync(join(root, "rust"), { recursive: true });
    mkdirSync(join(root, "harness", "fixtures"), { recursive: true });

    let buildNumber = 0;
    const runner = new FakeCommandRunner((spec) => {
      mkdirSync(dirname(spec.stdoutPath), { recursive: true });
      writeFileSync(spec.stdoutPath, "");
      writeFileSync(spec.stderrPath, "");

      if (spec.file === "bun") {
        writeFileSync(serverArtifactPath(cacheDir, platform), `server-${buildNumber}`);
        return;
      }

      if (spec.args.includes("-p")) {
        mkdirSync(dirname(clientArtifactPath(root, platform)), { recursive: true });
        writeFileSync(clientArtifactPath(root, platform), `client-${buildNumber}`);
        return;
      }

      mkdirSync(dirname(fixtureArtifactPath(root, platform)), { recursive: true });
      writeFileSync(fixtureArtifactPath(root, platform), `fixture-${buildNumber}`);
    });

    try {
      await buildArtifacts(
        { root, cacheRoot, platform, runner },
        buildDependencies(revision, architecture)
      );

      writeFileSync(serverArtifactPath(cacheDir, platform), "tampered");
      buildNumber = 1;

      const rebuilt = await buildArtifacts(
        { root, cacheRoot, platform, runner },
        buildDependencies(revision, architecture)
      );

      expect(rebuilt).toEqual(expectedArtifacts(root, cacheDir, platform, revision));
      expect(runner.calls).toHaveLength(6);
      expect(readFileSync(serverArtifactPath(cacheDir, platform), "utf8")).toBe("server-1");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rebuilds when manifest identity fields change", async () => {
    const workspace = makeWorkspace("build-cache-identity");
    const root = join(workspace, "repo");
    const cacheRoot = join(workspace, "cache");
    const platform: HarnessPlatform = "linux";
    const architecture = "arm64";
    const revision = "fedcba";
    const cacheDir = join(cacheRoot, revision, platform, architecture);

    mkdirSync(join(root, "rust"), { recursive: true });
    mkdirSync(join(root, "harness", "fixtures"), { recursive: true });

    const runner = new FakeCommandRunner((spec) => {
      mkdirSync(dirname(spec.stdoutPath), { recursive: true });
      writeFileSync(spec.stdoutPath, "");
      writeFileSync(spec.stderrPath, "");

      if (spec.file === "bun") {
        writeFileSync(serverArtifactPath(cacheDir, platform), "server");
        return;
      }

      if (spec.args.includes("-p")) {
        mkdirSync(dirname(clientArtifactPath(root, platform)), { recursive: true });
        writeFileSync(clientArtifactPath(root, platform), "client");
        return;
      }

      mkdirSync(dirname(fixtureArtifactPath(root, platform)), { recursive: true });
      writeFileSync(fixtureArtifactPath(root, platform), "fixture");
    });

    try {
      await buildArtifacts(
        { root, cacheRoot, platform, runner },
        buildDependencies(revision, architecture)
      );

      await buildArtifacts(
        { root, cacheRoot, platform, runner },
        buildDependencies(revision, architecture, {
          readToolVersions: async () => ({ ...toolVersions(), bun: "1.3.11" }),
        })
      );

      expect(runner.calls).toHaveLength(6);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rebuilds when the manifest is malformed", async () => {
    const workspace = makeWorkspace("build-cache-malformed-manifest");
    const root = join(workspace, "repo");
    const cacheRoot = join(workspace, "cache");
    const platform: HarnessPlatform = "linux";
    const architecture = "x64";
    const revision = "malformed123";
    const cacheDir = join(cacheRoot, revision, platform, architecture);

    mkdirSync(join(root, "rust"), { recursive: true });
    mkdirSync(join(root, "harness", "fixtures"), { recursive: true });

    let buildNumber = 0;
    const runner = new FakeCommandRunner((spec) => {
      mkdirSync(dirname(spec.stdoutPath), { recursive: true });
      writeFileSync(spec.stdoutPath, "");
      writeFileSync(spec.stderrPath, "");

      if (spec.file === "bun") {
        writeFileSync(serverArtifactPath(cacheDir, platform), `server-${buildNumber}`);
        return;
      }

      if (spec.args.includes("-p")) {
        mkdirSync(dirname(clientArtifactPath(root, platform)), { recursive: true });
        writeFileSync(clientArtifactPath(root, platform), `client-${buildNumber}`);
        return;
      }

      mkdirSync(dirname(fixtureArtifactPath(root, platform)), { recursive: true });
      writeFileSync(fixtureArtifactPath(root, platform), `fixture-${buildNumber}`);
    });

    try {
      await buildArtifacts(
        { root, cacheRoot, platform, runner },
        buildDependencies(revision, architecture)
      );

      writeFileSync(join(cacheDir, "manifest.json"), "{not-json\n");
      buildNumber = 1;

      const rebuilt = await buildArtifacts(
        { root, cacheRoot, platform, runner },
        buildDependencies(revision, architecture)
      );

      expect(rebuilt).toEqual(expectedArtifacts(root, cacheDir, platform, revision));
      expect(runner.calls).toHaveLength(6);
      expect(readFileSync(serverArtifactPath(cacheDir, platform), "utf8")).toBe("server-1");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("bypasses an existing manifest cache when the worktree is dirty", async () => {
    const workspace = makeWorkspace("build-cache-dirty-bypass");
    const root = join(workspace, "repo");
    const cacheRoot = join(workspace, "cache");
    const platform: HarnessPlatform = "linux";
    const architecture = "x64";
    const revision = "dirty123";
    const cacheDir = join(cacheRoot, revision, platform, architecture);

    mkdirSync(join(root, "rust"), { recursive: true });
    mkdirSync(join(root, "harness", "fixtures"), { recursive: true });

    let buildNumber = 0;
    const runner = new FakeCommandRunner((spec) => {
      mkdirSync(dirname(spec.stdoutPath), { recursive: true });
      writeFileSync(spec.stdoutPath, "");
      writeFileSync(spec.stderrPath, "");

      if (spec.file === "bun") {
        writeFileSync(serverArtifactPath(cacheDir, platform), `server-${buildNumber}`);
        return;
      }

      if (spec.args.includes("-p")) {
        mkdirSync(dirname(clientArtifactPath(root, platform)), { recursive: true });
        writeFileSync(clientArtifactPath(root, platform), `client-${buildNumber}`);
        return;
      }

      mkdirSync(dirname(fixtureArtifactPath(root, platform)), { recursive: true });
      writeFileSync(fixtureArtifactPath(root, platform), `fixture-${buildNumber}`);
    });

    try {
      await buildArtifacts(
        { root, cacheRoot, platform, runner },
        buildDependencies(revision, architecture)
      );

      const cleanManifest = readFileSync(join(cacheDir, "manifest.json"), "utf8");
      buildNumber = 1;

      const rebuilt = await buildArtifacts(
        { root, cacheRoot, platform, runner },
        buildDependencies(revision, architecture, {
          isWorktreeClean: async () => false,
        })
      );

      expect(rebuilt).toEqual(expectedArtifacts(root, cacheDir, platform, revision));
      expect(runner.calls).toHaveLength(6);
      expect(readFileSync(serverArtifactPath(cacheDir, platform), "utf8")).toBe("server-1");
      expect(readFileSync(join(cacheDir, "manifest.json"), "utf8")).toBe(cleanManifest);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("does not write a manifest for a dirty first build and writes one after a later clean rebuild", async () => {
    const workspace = makeWorkspace("build-cache-dirty-first");
    const root = join(workspace, "repo");
    const cacheRoot = join(workspace, "cache");
    const platform: HarnessPlatform = "linux";
    const architecture = "x64";
    const revision = "dirty-first-123";
    const cacheDir = join(cacheRoot, revision, platform, architecture);
    const manifestPath = join(cacheDir, "manifest.json");

    mkdirSync(join(root, "rust"), { recursive: true });
    mkdirSync(join(root, "harness", "fixtures"), { recursive: true });

    let buildNumber = 0;
    const runner = new FakeCommandRunner((spec) => {
      mkdirSync(dirname(spec.stdoutPath), { recursive: true });
      writeFileSync(spec.stdoutPath, "");
      writeFileSync(spec.stderrPath, "");

      if (spec.file === "bun") {
        writeFileSync(serverArtifactPath(cacheDir, platform), `server-${buildNumber}`);
        return;
      }

      if (spec.args.includes("-p")) {
        mkdirSync(dirname(clientArtifactPath(root, platform)), { recursive: true });
        writeFileSync(clientArtifactPath(root, platform), `client-${buildNumber}`);
        return;
      }

      mkdirSync(dirname(fixtureArtifactPath(root, platform)), { recursive: true });
      writeFileSync(fixtureArtifactPath(root, platform), `fixture-${buildNumber}`);
    });

    try {
      const dirtyBuild = await buildArtifacts(
        { root, cacheRoot, platform, runner },
        buildDependencies(revision, architecture, {
          isWorktreeClean: async () => false,
        })
      );

      expect(dirtyBuild).toEqual(expectedArtifacts(root, cacheDir, platform, revision));
      expect(() => statSync(manifestPath)).toThrow();

      buildNumber = 1;
      const cleanBuild = await buildArtifacts(
        { root, cacheRoot, platform, runner },
        buildDependencies(revision, architecture, {
          isWorktreeClean: async () => true,
        })
      );

      expect(cleanBuild).toEqual(expectedArtifacts(root, cacheDir, platform, revision));
      expect(runner.calls).toHaveLength(6);
      expect(statSync(manifestPath).isFile()).toBe(true);
      expect(readFileSync(serverArtifactPath(cacheDir, platform), "utf8")).toBe("server-1");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("classifies a missing build artifact as a build failure", async () => {
    const workspace = makeWorkspace("build-cache-missing-artifact");

    try {
      const error = await buildArtifacts(
        {
          root: workspace,
          cacheRoot: join(workspace, "cache"),
          platform: "linux",
          runner: new FakeCommandRunner(() => undefined),
        },
        buildDependencies("missing-artifact", "x64")
      ).catch((caught: unknown) => caught);

      expect(error).toEqual(
        expect.objectContaining({
          name: "HarnessError",
          kind: "build",
          message: expect.stringContaining("client artifact"),
        })
      );
      expect(error).toBeInstanceOf(HarnessError);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
