import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getClimonHome } from "./config.js";
import { atomicWrite } from "./store.js";

/**
 * Anonymous, per-installation identifier.
 *
 * The id is a random UUID v4 stored in `$CLIMON_HOME/install.json`. It contains
 * no PII and is the only stable identifier attached to Application Insights
 * telemetry, so individual installations can be distinguished without
 * identifying the user or machine.
 *
 * This module is intentionally self-contained: the unmerged installer/upgrader
 * work also defines an `install.id`; both must read the same value once that
 * lands, at which point the storage location here is reconciled with it.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Absolute path to the install-id file for the given environment. */
export function getInstallIdPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getClimonHome(env), "install.json");
}

function serialize(id: string): string {
  return `${JSON.stringify({ id }, null, 2)}\n`;
}

function parseValidId(raw: string): string | undefined {
  try {
    const value = (JSON.parse(raw) as { id?: unknown }).id;
    return typeof value === "string" && UUID_RE.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the existing install id without creating one. Returns undefined when
 * the file is absent, unreadable, or does not contain a valid id.
 */
export function getInstallId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    // Synchronous read keeps this usable from non-async startup paths.
    const raw = readFileSync(getInstallIdPath(env), "utf8");
    return parseValidId(raw);
  } catch {
    return undefined;
  }
}

async function readValidId(path: string): Promise<string | undefined> {
  try {
    return parseValidId(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Returns the install id, generating and persisting one if absent or invalid.
 *
 * Race-safe: the first writer wins via an exclusive (`wx`) create; concurrent
 * callers that lose the race read and return the winner's id, so all callers
 * converge on a single value. A present-but-corrupt file is overwritten.
 */
export async function ensureInstallId(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const path = getInstallIdPath(env);

  const existing = await readValidId(path);
  if (existing) return existing;

  const id = randomUUID();
  await mkdir(dirname(path), { recursive: true });

  try {
    await writeFile(path, serialize(id), { flag: "wx" });
    return id;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Another process created the file between our read and write.
    const winner = await readValidId(path);
    if (winner) return winner;
    // File exists but is invalid (e.g. corrupt): replace it atomically.
    await atomicWrite(path, serialize(id));
    return id;
  }
}
