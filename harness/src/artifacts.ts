import { appendFile, copyFile, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "./types.js";

const REDACTED_VALUE = "[redacted]";
const REDACT_KEY_PATTERN = /token|secret|password|connection|string|key/i;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableValue(entry));
  }

  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }

  return value;
}

function ensureContainedPath(root: string, name: string): string {
  if (name.length === 0) {
    throw new HarnessError("prerequisite", "Artifact path must not be empty");
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, name);
  const relative = path.relative(resolvedRoot, resolvedPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HarnessError("prerequisite", `Artifact path escapes the case directory: ${name}`);
  }

  return resolvedPath;
}

async function copySnapshotNode(sourcePath: string, destinationPath: string): Promise<void> {
  const sourceStat = await lstat(sourcePath);

  if (sourceStat.isDirectory()) {
    await mkdir(destinationPath, { recursive: true });
    for (const entry of await readdir(sourcePath)) {
      await copySnapshotNode(
        path.join(sourcePath, entry),
        path.join(destinationPath, entry)
      );
    }
    return;
  }

  if (sourceStat.isFile()) {
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
}

export function caseArtifactDir(artifactRoot: string, caseId: string): string {
  return path.join(artifactRoot, "cases", caseId);
}

export function redactRecord(
  record: Record<string, string | undefined>
): Record<string, string> {
  const redacted: Record<string, string> = {};

  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) {
      continue;
    }

    redacted[key] = REDACT_KEY_PATTERN.test(key) ? REDACTED_VALUE : String(value);
  }

  return redacted;
}

export class CaseArtifacts {
  public constructor(public readonly dir: string) {}

  public async initialize(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
  }

  public async appendText(name: string, text: string): Promise<void> {
    const destinationPath = ensureContainedPath(this.dir, name);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await appendFile(destinationPath, text, "utf8");
  }

  public async writeJson(name: string, value: unknown): Promise<void> {
    const destinationPath = ensureContainedPath(this.dir, name);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await writeFile(
      destinationPath,
      `${JSON.stringify(stableValue(value), null, 2)}\n`,
      "utf8"
    );
  }

  public async snapshotTree(source: string, destinationName: string): Promise<void> {
    const destinationPath = ensureContainedPath(this.dir, destinationName);
    await copySnapshotNode(source, destinationPath);
  }
}
