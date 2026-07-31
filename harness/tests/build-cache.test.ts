import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildArtifacts,
  planBuild,
} from "../src/build-cache.js";
import type { CommandResult, CommandRunner, CommandSpec } from "../src/command.js";
import type { HarnessPlatform } from "../src/types.js";

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

function artifactPath(root: string, platform: HarnessPlatform, name: string): string {
  const suffix = platform === "windows" ? ".exe" : "";

  if (name === "client") {
    return join(root, "rust", "target", "release", `climon${suffix}`);
  }

  if (name === "fixture") {
    return join(
      root,
      "harness",
      "fixtures",
      "target",
      "release",
      `climon-harness-fixture${suffix}`
    );
  }

  throw new Error(`Unknown artifact name: ${name}`);
}

class FakeCommandRunner implements CommandRunner {
  public readonly calls: CommandSpec[] = [];

  public constructor(
    private readonly onRun: (spec: CommandSpec) => void
  ) {}

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
      commands: plan.commands.map(
        ({ file, args, cwd, timeoutMs, stdoutPath, stderrPath }) => ({
          file,
          args,
          cwd,
          timeoutMs,
          stdoutPath,
          stderrPath,
        })
      ),
    }).toEqual({
      clientPath: "/repo/rust/target/release/climon.exe",
      serverPath: "/cache/climon-server.exe",
      fixturePath:
        "/repo/harness/fixtures/target/release/climon-harness-fixture.exe",
      commands: [
        {
          file: "cargo",
          args: ["build", "--release", "-p", "climon-cli"],
          cwd: "/repo/rust",
          timeoutMs: 600_000,
          stdoutPath: "/cache/logs/01-cargo-client.stdout.log",
          stderrPath: "/cache/logs/01-cargo-client.stderr.log",
        },
        {
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
        {
          file: "cargo",
          args: [
            "build",
            "--release",
            "--manifest-path",
            "harness/fixtures/Cargo.toml",
          ],
          cwd: "/repo",
          timeoutMs: 600_000,
          stdoutPath: "/cache/logs/03-cargo-fixture.stdout.log",
          stderrPath: "/cache/logs/03-cargo-fixture.stderr.log",
        },
      ],
    });
    for (const command of plan.commands) {
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
    writeFileSync(join(root, ".git"), "gitdir: .git-data\n");
    mkdirSync(join(root, ".git-data"), { recursive: true });
    writeFileSync(join(root, ".git-data", "HEAD"), `${revision}\n`);

    const runner = new FakeCommandRunner((spec) => {
      mkdirSync(spec.cwd, { recursive: true });
      mkdirSync(join(cacheDir, "logs"), { recursive: true });
      mkdirSync(dirname(spec.stdoutPath), { recursive: true });
      writeFileSync(spec.stdoutPath, `stdout:${spec.file}`);
      writeFileSync(spec.stderrPath, "");

      if (spec.file === "bun") {
        writeFileSync(join(cacheDir, "climon-server"), "server-binary");
        return;
      }

      if (spec.args.includes("-p")) {
        mkdirSync(dirname(artifactPath(root, platform, "client")), { recursive: true });
        writeFileSync(artifactPath(root, platform, "client"), "client-binary");
        return;
      }

      mkdirSync(dirname(artifactPath(root, platform, "fixture")), { recursive: true });
      writeFileSync(artifactPath(root, platform, "fixture"), "fixture-binary");
    });

    const dependencies = {
      readRevision: async () => revision,
      readToolVersions: async () => ({
        bun: "1.3.10",
        node: "24.0.0",
        rust: "1.89.0",
        playwright: "1.62.1",
        chromium: "151.0.7922.34",
      }),
      isWorktreeClean: async () => true,
    };

    try {
      const first = await buildArtifacts(
        root,
        cacheRoot,
        platform,
        architecture,
        runner,
        dependencies
      );
      const secondRunner = new FakeCommandRunner(() => {
        throw new Error("cache reuse should not rebuild");
      });
      const second = await buildArtifacts(
        root,
        cacheRoot,
        platform,
        architecture,
        secondRunner,
        dependencies
      );

      expect(first).toEqual({
        clientPath: artifactPath(root, platform, "client"),
        serverPath: join(cacheDir, "climon-server"),
        fixturePath: artifactPath(root, platform, "fixture"),
      });
      expect(second).toEqual(first);
      expect(runner.calls).toHaveLength(3);
      expect(secondRunner.calls).toHaveLength(0);

      const manifest = JSON.parse(
        readFileSync(join(cacheDir, "manifest.json"), "utf8")
      ) as {
        revision: string;
        platform: string;
        architecture: string;
        versions: Record<string, string>;
        checksums: Record<string, string>;
      };

      expect(manifest.revision).toBe(revision);
      expect(manifest.platform).toBe(platform);
      expect(manifest.architecture).toBe(architecture);
      expect(manifest.versions).toEqual({
        bun: "1.3.10",
        node: "24.0.0",
        rust: "1.89.0",
        playwright: "1.62.1",
        chromium: "151.0.7922.34",
      });
      expect(Object.keys(manifest.checksums).sort()).toEqual([
        "client",
        "fixture",
        "server",
      ]);
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
      if (spec.file === "bun") {
        mkdirSync(dirname(join(cacheDir, "climon-server")), { recursive: true });
        writeFileSync(join(cacheDir, "climon-server"), `server-${buildNumber}`);
      } else if (spec.args.includes("-p")) {
        mkdirSync(dirname(artifactPath(root, platform, "client")), { recursive: true });
        writeFileSync(
          artifactPath(root, platform, "client"),
          `client-${buildNumber}`
        );
      } else {
        mkdirSync(dirname(artifactPath(root, platform, "fixture")), { recursive: true });
        writeFileSync(
          artifactPath(root, platform, "fixture"),
          `fixture-${buildNumber}`
        );
      }

      mkdirSync(dirname(spec.stdoutPath), { recursive: true });
      writeFileSync(spec.stdoutPath, "");
      writeFileSync(spec.stderrPath, "");
    });

    const dependencies = {
      readRevision: async () => revision,
      readToolVersions: async () => ({
        bun: "1.3.10",
        node: "24.0.0",
        rust: "1.89.0",
        playwright: "1.62.1",
        chromium: "151.0.7922.34",
      }),
    };

    try {
      await buildArtifacts(
        root,
        cacheRoot,
        platform,
        architecture,
        runner,
        dependencies
      );

      writeFileSync(join(cacheDir, "climon-server"), "tampered");
      buildNumber = 1;

      await buildArtifacts(
        root,
        cacheRoot,
        platform,
        architecture,
        runner,
        dependencies
      );

      expect(runner.calls).toHaveLength(6);
      expect(readFileSync(join(cacheDir, "climon-server"), "utf8")).toBe(
        "server-1"
      );
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
      if (spec.file === "bun") {
        mkdirSync(dirname(join(cacheDir, "climon-server")), { recursive: true });
        writeFileSync(join(cacheDir, "climon-server"), "server");
      } else if (spec.args.includes("-p")) {
        mkdirSync(dirname(artifactPath(root, platform, "client")), { recursive: true });
        writeFileSync(artifactPath(root, platform, "client"), "client");
      } else {
        mkdirSync(dirname(artifactPath(root, platform, "fixture")), { recursive: true });
        writeFileSync(artifactPath(root, platform, "fixture"), "fixture");
      }

      mkdirSync(dirname(spec.stdoutPath), { recursive: true });
      writeFileSync(spec.stdoutPath, "");
      writeFileSync(spec.stderrPath, "");
    });

    try {
      await buildArtifacts(root, cacheRoot, platform, architecture, runner, {
        readRevision: async () => revision,
        readToolVersions: async () => ({
          bun: "1.3.10",
          node: "24.0.0",
          rust: "1.89.0",
          playwright: "1.62.1",
          chromium: "151.0.7922.34",
        }),
        isWorktreeClean: async () => true,
      });

      await buildArtifacts(root, cacheRoot, platform, architecture, runner, {
        readRevision: async () => revision,
        readToolVersions: async () => ({
          bun: "1.3.11",
          node: "24.0.0",
          rust: "1.89.0",
          playwright: "1.62.1",
          chromium: "151.0.7922.34",
        }),
        isWorktreeClean: async () => true,
      });

      expect(runner.calls).toHaveLength(6);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rebuilds instead of reusing cached artifacts when the checkout is dirty", async () => {
    const workspace = makeWorkspace("build-cache-dirty");
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
      if (spec.file === "bun") {
        mkdirSync(dirname(join(cacheDir, "climon-server")), { recursive: true });
        writeFileSync(join(cacheDir, "climon-server"), `server-${buildNumber}`);
      } else if (spec.args.includes("-p")) {
        mkdirSync(dirname(artifactPath(root, platform, "client")), { recursive: true });
        writeFileSync(artifactPath(root, platform, "client"), `client-${buildNumber}`);
      } else {
        mkdirSync(dirname(artifactPath(root, platform, "fixture")), { recursive: true });
        writeFileSync(
          artifactPath(root, platform, "fixture"),
          `fixture-${buildNumber}`
        );
      }

      mkdirSync(dirname(spec.stdoutPath), { recursive: true });
      writeFileSync(spec.stdoutPath, "");
      writeFileSync(spec.stderrPath, "");
    });

    try {
      await buildArtifacts(root, cacheRoot, platform, architecture, runner, {
        readRevision: async () => revision,
        readToolVersions: async () => ({
          bun: "1.3.10",
          node: "24.0.0",
          rust: "1.89.0",
          playwright: "1.62.1",
          chromium: "151.0.7922.34",
        }),
        isWorktreeClean: async () => true,
      });

      buildNumber = 1;

      await buildArtifacts(root, cacheRoot, platform, architecture, runner, {
        readRevision: async () => revision,
        readToolVersions: async () => ({
          bun: "1.3.10",
          node: "24.0.0",
          rust: "1.89.0",
          playwright: "1.62.1",
          chromium: "151.0.7922.34",
        }),
        isWorktreeClean: async () => false,
      });

      expect(runner.calls).toHaveLength(6);
      expect(readFileSync(join(cacheDir, "climon-server"), "utf8")).toBe(
        "server-1"
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("does not reuse a manifest written by a dirty build after the checkout becomes clean", async () => {
    const workspace = makeWorkspace("build-cache-dirty-then-clean");
    const root = join(workspace, "repo");
    const cacheRoot = join(workspace, "cache");
    const platform: HarnessPlatform = "linux";
    const architecture = "x64";
    const revision = "dirty-clean-123";
    const cacheDir = join(cacheRoot, revision, platform, architecture);

    mkdirSync(join(root, "rust"), { recursive: true });
    mkdirSync(join(root, "harness", "fixtures"), { recursive: true });

    let buildNumber = 0;
    const runner = new FakeCommandRunner((spec) => {
      if (spec.file === "bun") {
        mkdirSync(dirname(join(cacheDir, "climon-server")), { recursive: true });
        writeFileSync(join(cacheDir, "climon-server"), `server-${buildNumber}`);
      } else if (spec.args.includes("-p")) {
        mkdirSync(dirname(artifactPath(root, platform, "client")), { recursive: true });
        writeFileSync(artifactPath(root, platform, "client"), `client-${buildNumber}`);
      } else {
        mkdirSync(dirname(artifactPath(root, platform, "fixture")), { recursive: true });
        writeFileSync(
          artifactPath(root, platform, "fixture"),
          `fixture-${buildNumber}`
        );
      }

      mkdirSync(dirname(spec.stdoutPath), { recursive: true });
      writeFileSync(spec.stdoutPath, "");
      writeFileSync(spec.stderrPath, "");
    });

    try {
      await buildArtifacts(root, cacheRoot, platform, architecture, runner, {
        readRevision: async () => revision,
        readToolVersions: async () => ({
          bun: "1.3.10",
          node: "24.0.0",
          rust: "1.89.0",
          playwright: "1.62.1",
          chromium: "151.0.7922.34",
        }),
        isWorktreeClean: async () => false,
      });

      buildNumber = 1;

      await buildArtifacts(root, cacheRoot, platform, architecture, runner, {
        readRevision: async () => revision,
        readToolVersions: async () => ({
          bun: "1.3.10",
          node: "24.0.0",
          rust: "1.89.0",
          playwright: "1.62.1",
          chromium: "151.0.7922.34",
        }),
        isWorktreeClean: async () => true,
      });

      expect(runner.calls).toHaveLength(6);
      expect(readFileSync(join(cacheDir, "climon-server"), "utf8")).toBe(
        "server-1"
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
