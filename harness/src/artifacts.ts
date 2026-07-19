import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  CaseResult,
  FailureKind,
  HarnessCase,
  HarnessPlatform,
} from "./types.js";
import { HarnessError } from "./types.js";

const REDACT_RE = /token|secret|password|connection|string|key/i;

export function redactEnvironment(
  env: Record<string, string | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    result[key] = REDACT_RE.test(key) ? "[REDACTED]" : value;
  }
  return result;
}

export type FileTypeCategory =
  | "file"
  | "directory"
  | "socket"
  | "fifo"
  | "other";

export function shouldSnapshotFileType(type: FileTypeCategory): boolean {
  return type === "file" || type === "directory";
}

async function classifyPath(p: string): Promise<FileTypeCategory> {
  const stat = await lstat(p);
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSocket()) return "socket";
  if (stat.isFIFO()) return "fifo";
  return "other";
}

export async function snapshotHome(
  home: string,
  destination: string
): Promise<void> {
  await snapshotDir(home, destination, home);
}

async function snapshotDir(
  dir: string,
  dstBase: string,
  homeBase: string
): Promise<void> {
  const entries = await readdir(dir);
  for (const name of entries) {
    const srcPath = join(dir, name);
    const type = await classifyPath(srcPath);
    if (type === "file") {
      const dstPath = join(dstBase, relative(homeBase, srcPath));
      await mkdir(dirname(dstPath), { recursive: true });
      await copyFile(srcPath, dstPath);
    } else if (type === "directory") {
      const dstPath = join(dstBase, relative(homeBase, srcPath));
      await mkdir(dstPath, { recursive: true });
      await snapshotDir(srcPath, dstBase, homeBase);
    }
    // symlinks, sockets, FIFOs, and other types are intentionally skipped
  }
}

export async function writeCaseResult(
  artifactDir: string,
  result: CaseResult
): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    join(artifactDir, "result.json"),
    JSON.stringify(result, null, 2) + "\n"
  );
  const lines = [
    "# Case Result",
    "",
    `- **ID:** ${result.id}`,
    `- **Platform:** ${result.platform}`,
    `- **Status:** ${result.status}`,
    `- **Duration:** ${result.durationMs}ms`,
  ];
  if (result.failureKind) {
    lines.push(`- **Failure kind:** ${result.failureKind}`);
  }
  if (result.message) {
    lines.push(`- **Message:** ${result.message}`);
  }
  await writeFile(join(artifactDir, "summary.md"), lines.join("\n") + "\n");
}

const CASE_ID_RE = /^[A-Za-z0-9._-]+$/;

export function caseArtifactDir(artifactRoot: string, caseId: string): string {
  if (!CASE_ID_RE.test(caseId)) {
    throw new HarnessError(
      "catalogue",
      `invalid case id: "${caseId}" — only [A-Za-z0-9._-] are allowed`
    );
  }
  const casesRoot = resolve(artifactRoot, "cases");
  const candidate = resolve(casesRoot, caseId);
  if (!candidate.startsWith(casesRoot + sep)) {
    throw new HarnessError(
      "catalogue",
      `invalid case id: "${caseId}" — must be a direct child of cases/`
    );
  }
  return candidate;
}

export function failureResult(
  definition: HarnessCase,
  platform: HarnessPlatform,
  error: unknown,
  startedAt: number,
  artifactDir: string
): CaseResult {
  const durationMs = Math.max(0, Date.now() - startedAt);
  const kind: FailureKind =
    error instanceof HarnessError ? error.kind : "assertion";
  const message =
    error instanceof Error ? error.message : String(error);
  return {
    id: definition.id,
    platform,
    status: "failed",
    durationMs,
    failureKind: kind,
    message,
    artifactDir,
  };
}
