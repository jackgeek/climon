import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getScrollbackPath, getSessionMetaPath, getSessionsDir } from "./config.js";
import type { SessionMeta, SessionMetaPatch } from "./types.js";

let tempCounter = 0;

async function atomicWrite(path: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${tempCounter++}.tmp`;
  await writeFile(tempPath, data);
  await rename(tempPath, path);
}

export async function writeSessionMeta(meta: SessionMeta, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await atomicWrite(getSessionMetaPath(meta.id, env), `${JSON.stringify(meta, null, 2)}\n`);
}

export async function readSessionMeta(id: string, env: NodeJS.ProcessEnv = process.env): Promise<SessionMeta | undefined> {
  try {
    const raw = await readFile(getSessionMetaPath(id, env), "utf8");
    return JSON.parse(raw) as SessionMeta;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

// Serializes patchSessionMeta calls per session id within this process, while
// the lock directory below serializes read-merge-write patches across daemon
// and server processes. Without both layers, concurrent patches can silently
// drop fields or overwrite fresher status transitions.
const patchQueues = new Map<string, Promise<unknown>>();
const PATCH_LOCK_RETRY_MS = 10;
const PATCH_LOCK_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquirePatchLock(id: string, env: NodeJS.ProcessEnv): Promise<() => Promise<void>> {
  const lockPath = `${getSessionMetaPath(id, env)}.lock`;
  const deadline = Date.now() + PATCH_LOCK_TIMEOUT_MS;
  await mkdir(dirname(lockPath), { recursive: true });
  while (true) {
    try {
      await mkdir(lockPath);
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for session metadata lock: ${id}`);
      }
      await sleep(PATCH_LOCK_RETRY_MS);
    }
  }
}

async function patchSessionMetaQueued(
  id: string,
  patch: SessionMetaPatch,
  validateCurrent: ((current: SessionMeta) => void) | undefined,
  env: NodeJS.ProcessEnv
): Promise<SessionMeta | undefined> {
  const prior = patchQueues.get(id) ?? Promise.resolve();
  const run = prior.then(async () => {
    const releaseLock = await acquirePatchLock(id, env);
    try {
      const current = await readSessionMeta(id, env);
      if (!current) {
        return undefined;
      }
      validateCurrent?.(current);
      const updated: SessionMeta = { ...current, ...patch, updatedAt: new Date().toISOString() };
      await writeSessionMeta(updated, env);
      return updated;
    } finally {
      await releaseLock();
    }
  });
  // The queued tail never rejects, so later patches always run after this one.
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  patchQueues.set(id, tail);
  void tail.then(() => {
    // Prune once this was the last patch in the chain.
    if (patchQueues.get(id) === tail) {
      patchQueues.delete(id);
    }
  });
  return run;
}

export async function patchSessionMeta(
  id: string,
  patch: SessionMetaPatch,
  env: NodeJS.ProcessEnv = process.env
): Promise<SessionMeta | undefined> {
  return patchSessionMetaQueued(id, patch, undefined, env);
}

export async function patchSessionMetaWithCurrent(
  id: string,
  patch: SessionMetaPatch,
  validateCurrent: (current: SessionMeta) => void,
  env: NodeJS.ProcessEnv = process.env
): Promise<SessionMeta | undefined> {
  return patchSessionMetaQueued(id, patch, validateCurrent, env);
}

export async function listSessions(env: NodeJS.ProcessEnv = process.env): Promise<SessionMeta[]> {
  const dir = getSessionsDir(env);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const sessions: SessionMeta[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    try {
      const raw = await readFile(join(dir, entry), "utf8");
      sessions.push(JSON.parse(raw) as SessionMeta);
    } catch {
      // Skip partially written or corrupt entries.
    }
  }
  return sessions;
}

export async function removeSessionMeta(id: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const path = getSessionMetaPath(id, env);
  try {
    await rm(path, { force: false });
    await rm(getScrollbackPath(id, env), { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function writeScrollback(id: string, data: Buffer, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await atomicWrite(getScrollbackPath(id, env), data);
}

export async function readScrollback(id: string, env: NodeJS.ProcessEnv = process.env): Promise<Buffer | undefined> {
  try {
    return await readFile(getScrollbackPath(id, env));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
