import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path, { join } from "node:path";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { compiledServerBuildArgs } from "../../scripts/server-build.js";
import type { CommandRunner, CommandSpec } from "./command.js";
import { HarnessError, type HarnessPlatform } from "./types.js";

export interface BuildArtifacts {
  clientPath: string;
  serverPath: string;
  fixturePath: string;
  revision: string;
  manifestPath: string;
}

export interface BuildPlan {
  clientPath: string;
  serverPath: string;
  fixturePath: string;
  client: CommandSpec;
  server: CommandSpec;
  fixture: CommandSpec;
}

interface ToolVersions {
  bun: string;
  node: string;
  rust: string;
  playwright: string;
  chromium: string;
}

interface BuildManifest {
  revision: string;
  platform: HarnessPlatform;
  architecture: string;
  bun: string;
  node: string;
  rust: string;
  playwright: string;
  chromium: string;
  checksums: Record<"client" | "server" | "fixture", string>;
}

interface BuildArtifactsMap {
  clientPath: string;
  serverPath: string;
  fixturePath: string;
  client: string;
  server: string;
  fixture: string;
}

interface BuildCacheDependencies {
  architecture: string;
  readRevision(root: string): Promise<string>;
  readToolVersions(): Promise<ToolVersions>;
  isWorktreeClean(root: string): Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const require = createRequire(import.meta.url);
const playwrightPackage = require("playwright/package.json") as { version: string };
const playwrightCorePackagePath = require.resolve("playwright-core/package.json");

function pathApiFor(...paths: string[]): typeof path.posix | typeof path.win32 {
  return paths.some((value) => value.includes("\\") || /^[A-Za-z]:/.test(value))
    ? path.win32
    : path.posix;
}

function executableName(name: string, platform: HarnessPlatform): string {
  return platform === "windows" ? `${name}.exe` : name;
}

function logPath(
  pathApi: typeof path.posix | typeof path.win32,
  cacheDir: string,
  name: string,
  stream: "stdout" | "stderr"
): string {
  return pathApi.join(cacheDir, "logs", `${name}.${stream}.log`);
}

function buildManifestPath(
  pathApi: typeof path.posix | typeof path.win32,
  cacheDir: string
): string {
  return pathApi.join(cacheDir, "manifest.json");
}

function buildArtifactsMap(
  root: string,
  cacheDir: string,
  platform: HarnessPlatform
): BuildArtifactsMap {
  const pathApi = pathApiFor(root, cacheDir);

  return {
    clientPath: pathApi.join(
      root,
      "rust",
      "target",
      "release",
      executableName("climon", platform)
    ),
    serverPath: pathApi.join(cacheDir, executableName("climon-server", platform)),
    fixturePath: pathApi.join(
      root,
      "harness",
      "fixtures",
      "target",
      "release",
      executableName("climon-harness-fixture", platform)
    ),
    client: pathApi.join(
      root,
      "rust",
      "target",
      "release",
      executableName("climon", platform)
    ),
    server: pathApi.join(cacheDir, executableName("climon-server", platform)),
    fixture: pathApi.join(
      root,
      "harness",
      "fixtures",
      "target",
      "release",
      executableName("climon-harness-fixture", platform)
    ),
  };
}

export function planBuild(
  root: string,
  cacheDir: string,
  platform: HarnessPlatform
): BuildPlan {
  const pathApi = pathApiFor(root, cacheDir);
  const artifacts = buildArtifactsMap(root, cacheDir, platform);

  return {
    clientPath: artifacts.clientPath,
    serverPath: artifacts.serverPath,
    fixturePath: artifacts.fixturePath,
    client: {
      file: "cargo",
      args: ["build", "--release", "-p", "climon-cli"],
      cwd: pathApi.join(root, "rust"),
      env: { ...process.env },
      timeoutMs: DEFAULT_TIMEOUT_MS,
      stdoutPath: logPath(pathApi, cacheDir, "01-cargo-client", "stdout"),
      stderrPath: logPath(pathApi, cacheDir, "01-cargo-client", "stderr"),
    },
    server: {
      file: "bun",
      args: [...compiledServerBuildArgs(artifacts.serverPath)],
      cwd: root,
      env: { ...process.env },
      timeoutMs: DEFAULT_TIMEOUT_MS,
      stdoutPath: logPath(pathApi, cacheDir, "02-bun-server", "stdout"),
      stderrPath: logPath(pathApi, cacheDir, "02-bun-server", "stderr"),
    },
    fixture: {
      file: "cargo",
      args: ["build", "--release", "--manifest-path", "harness/fixtures/Cargo.toml"],
      cwd: root,
      env: { ...process.env },
      timeoutMs: DEFAULT_TIMEOUT_MS,
      stdoutPath: logPath(pathApi, cacheDir, "03-cargo-fixture", "stdout"),
      stderrPath: logPath(pathApi, cacheDir, "03-cargo-fixture", "stderr"),
    },
  };
}

async function sha256(filePath: string): Promise<string> {
  const file = createReadStream(filePath);
  const hash = createHash("sha256");

  return new Promise<string>((resolve, reject) => {
    file.on("data", (chunk) => hash.update(chunk));
    file.on("error", reject);
    file.on("end", () => resolve(hash.digest("hex")));
  });
}

async function assertFileExists(filePath: string, label: string): Promise<void> {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HarnessError(
        "build",
        `Expected ${label} artifact file: ${filePath}`,
        { cause: error }
      );
    }
    throw error;
  }
  if (!fileStat.isFile()) {
    throw new HarnessError("build", `Expected ${label} artifact file: ${filePath}`);
  }
}

async function readGitRevision(root: string): Promise<string> {
  const gitEntry = join(root, ".git");
  const gitEntryStat = await stat(gitEntry).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HarnessError("prerequisite", `Missing .git entry under ${root}`);
    }
    throw error;
  });

  let gitDir = gitEntry;
  if (gitEntryStat.isFile()) {
    const pointer = (await readFile(gitEntry, "utf8")).trim();
    const prefix = "gitdir:";
    if (!pointer.startsWith(prefix)) {
      throw new HarnessError("prerequisite", `Invalid .git file in ${root}`);
    }
    gitDir = path.resolve(root, pointer.slice(prefix.length).trim());
  }

  let commonDir = gitDir;
  try {
    const rawCommonDir = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
    if (rawCommonDir.length > 0) {
      commonDir = path.resolve(gitDir, rawCommonDir);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
  if (!head.startsWith("ref:")) {
    return head;
  }

  const ref = head.slice("ref:".length).trim();
  for (const candidate of [join(gitDir, ref), join(commonDir, ref)]) {
    try {
      return (await readFile(candidate, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  try {
    const packedRefs = await readFile(join(commonDir, "packed-refs"), "utf8");
    for (const line of packedRefs.split(/\r?\n/)) {
      if (line.startsWith("#") || line.startsWith("^") || line.length === 0) {
        continue;
      }

      const [revision, packedRef] = line.split(" ");
      if (packedRef === ref && revision !== undefined) {
        return revision.trim();
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  throw new HarnessError("prerequisite", `Unable to resolve git revision for ${root}`);
}

async function readGitWorktreeClean(root: string): Promise<boolean> {
  const spawnOptions = {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    shell: false,
  };
  let subprocess: ReturnType<typeof Bun.spawn>;

  try {
    subprocess = Bun.spawn(
      ["git", "-C", root, "status", "--porcelain", "--untracked-files=no"],
      spawnOptions as Parameters<typeof Bun.spawn>[1]
    );
  } catch (error) {
    throw new HarnessError(
      "prerequisite",
      `Failed to start git status for ${root}`,
      { cause: error }
    );
  }

  const stdout = await readStreamText(subprocess.stdout);
  const stderr = await readStreamText(subprocess.stderr);
  const code = await subprocess.exited;

  if (code !== 0) {
    throw new HarnessError(
      "prerequisite",
      `Failed to check git worktree status for ${root}: ${stderr.trim() || stdout.trim() || `exit code ${code}`}`
    );
  }

  return stdout.trim().length === 0;
}

async function readRustVersion(): Promise<string> {
  const spawnOptions = {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    shell: false,
  };
  let subprocess: ReturnType<typeof Bun.spawn>;
  try {
    subprocess = Bun.spawn(
      ["rustc", "--version"],
      spawnOptions as Parameters<typeof Bun.spawn>[1]
    );
  } catch (error) {
    throw new HarnessError(
      "prerequisite",
      "Failed to start rustc --version",
      { cause: error }
    );
  }
  const stdout = await readStreamText(subprocess.stdout);
  const stderr = await readStreamText(subprocess.stderr);
  const code = await subprocess.exited;

  if (code !== 0) {
    throw new HarnessError(
      "prerequisite",
      `Failed to read rustc version: ${stderr.trim() || stdout.trim()}`
    );
  }

  const version = stdout.trim().split(/\s+/)[1];
  return version ?? stdout.trim();
}

async function readStreamText(stream: unknown): Promise<string> {
  const reader = (stream as unknown as WebReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let output = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value !== undefined) {
        output += decoder.decode(value, { stream: true });
      }
    }

    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function readInstalledToolVersions(): Promise<ToolVersions> {
  const browsersMetadata = JSON.parse(
    await readFile(
      path.join(path.dirname(playwrightCorePackagePath), "browsers.json"),
      "utf8"
    )
  ) as {
    browsers: Array<{ name: string; browserVersion?: string }>;
  };
  const chromium = browsersMetadata.browsers.find(
    (browser) => browser.name === "chromium"
  )?.browserVersion;

  if (chromium === undefined) {
    throw new HarnessError("prerequisite", "Unable to determine Chromium version");
  }

  return {
    bun: Bun.version,
    node: process.versions.node,
    rust: await readRustVersion(),
    playwright: playwrightPackage.version,
    chromium,
  };
}

function isBuildManifest(value: unknown): value is BuildManifest {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.revision !== "string" ||
    typeof candidate.platform !== "string" ||
    typeof candidate.architecture !== "string" ||
    typeof candidate.bun !== "string" ||
    typeof candidate.node !== "string" ||
    typeof candidate.rust !== "string" ||
    typeof candidate.playwright !== "string" ||
    typeof candidate.chromium !== "string" ||
    typeof candidate.checksums !== "object" ||
    candidate.checksums === null
  ) {
    return false;
  }

  const checksums = candidate.checksums as Record<string, unknown>;
  return ["client", "server", "fixture"].every(
    (key) => typeof checksums[key] === "string"
  );
}

async function readManifest(manifestPath: string): Promise<BuildManifest | null> {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isBuildManifest(parsed) ? parsed : null;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    ) {
      return null;
    }
    throw error;
  }
}

function sameIdentity(
  manifest: BuildManifest,
  expected: Omit<BuildManifest, "checksums">
): boolean {
  return (
    manifest.revision === expected.revision &&
    manifest.platform === expected.platform &&
    manifest.architecture === expected.architecture &&
    manifest.bun === expected.bun &&
    manifest.node === expected.node &&
    manifest.rust === expected.rust &&
    manifest.playwright === expected.playwright &&
    manifest.chromium === expected.chromium
  );
}

async function manifestChecksumsMatch(
  manifest: BuildManifest,
  artifacts: BuildArtifactsMap
): Promise<boolean> {
  for (const [name, artifactPath] of [
    ["client", artifacts.client],
    ["server", artifacts.server],
    ["fixture", artifacts.fixture],
  ] as const) {
    try {
      if ((await sha256(artifactPath)) !== manifest.checksums[name]) {
        return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  return true;
}

async function writeManifestAtomic(
  manifestPath: string,
  manifest: BuildManifest
): Promise<void> {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function formatCommand(command: CommandSpec): string {
  return [command.file, ...command.args].join(" ");
}

async function runPlan(
  plan: BuildPlan,
  runner: CommandRunner
): Promise<void> {
  for (const command of [plan.client, plan.server, plan.fixture]) {
    const result = await runner.run(command);
    if (result.code !== 0) {
      throw new HarnessError(
        "build",
        `Build command failed with exit code ${result.code}: ${formatCommand(
          command
        )} (stdout: ${command.stdoutPath}; stderr: ${command.stderrPath})`
      );
    }
  }
}

async function checksumsForArtifacts(
  artifacts: BuildArtifactsMap
): Promise<BuildManifest["checksums"]> {
  await assertFileExists(artifacts.client, "client");
  await assertFileExists(artifacts.server, "server");
  await assertFileExists(artifacts.fixture, "fixture");

  return {
    client: await sha256(artifacts.client),
    server: await sha256(artifacts.server),
    fixture: await sha256(artifacts.fixture),
  };
}

export async function buildArtifacts(
  options: {
    root: string;
    cacheRoot: string;
    platform: HarnessPlatform;
    runner: CommandRunner;
  },
  dependencies: Partial<BuildCacheDependencies> = {}
): Promise<BuildArtifacts> {
  const { root, cacheRoot, platform, runner } = options;
  const architecture = dependencies.architecture ?? process.arch;
  const readRevision = dependencies.readRevision ?? readGitRevision;
  const readToolVersions = dependencies.readToolVersions ?? readInstalledToolVersions;
  const isWorktreeClean = dependencies.isWorktreeClean ?? readGitWorktreeClean;
  const revision = await readRevision(root);
  const versions = await readToolVersions();
  const worktreeClean = await isWorktreeClean(root);
  const pathApi = pathApiFor(root, cacheRoot);
  const cacheDir = pathApi.join(cacheRoot, revision, platform, architecture);
  const manifestPath = buildManifestPath(pathApi, cacheDir);
  const artifacts = buildArtifactsMap(root, cacheDir, platform);
  const manifestIdentity = {
    revision,
    platform,
    architecture,
    bun: versions.bun,
    node: versions.node,
    rust: versions.rust,
    playwright: versions.playwright,
    chromium: versions.chromium,
  };

  await mkdir(cacheDir, { recursive: true });

  if (worktreeClean) {
    const existingManifest = await readManifest(manifestPath);
    if (
      existingManifest !== null &&
      sameIdentity(existingManifest, manifestIdentity) &&
      (await manifestChecksumsMatch(existingManifest, artifacts))
    ) {
      return {
        clientPath: artifacts.clientPath,
        serverPath: artifacts.serverPath,
        fixturePath: artifacts.fixturePath,
        revision,
        manifestPath,
      };
    }
  }

  const plan = planBuild(root, cacheDir, platform);
  await runPlan(plan, runner);

  const manifest: BuildManifest = {
    ...manifestIdentity,
    checksums: await checksumsForArtifacts(artifacts),
  };

  if (worktreeClean) {
    await writeManifestAtomic(manifestPath, manifest);
  }

  return {
    clientPath: artifacts.clientPath,
    serverPath: artifacts.serverPath,
    fixturePath: artifacts.fixturePath,
    revision,
    manifestPath,
  };
}
