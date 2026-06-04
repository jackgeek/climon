import { mkdir, readdir, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
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
const PATCH_LOCK_STALE_MS = 60_000;
const PATCH_LOCK_OWNER_FILE = "owner.json";
const PATCH_LOCK_RECOVERY_SUFFIX = ".reclaim";

type PatchLockOptions = {
  timeoutMs?: number;
  retryMs?: number;
  staleMs?: number;
};

type PatchLockOwner = {
  pid: number;
  createdAt: string;
  hostname: string;
  platform: NodeJS.Platform;
  pidNamespace?: string;
  processStartTime?: string;
};

let currentPidNamespace: Promise<string | undefined> | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getCurrentPidNamespace(): Promise<string | undefined> {
  currentPidNamespace ??= (async () => {
    if (process.platform !== "linux") {
      return undefined;
    }
    try {
      return await readlink("/proc/self/ns/pid");
    } catch {
      return undefined;
    }
  })();
  return currentPidNamespace;
}

async function getProcessStartTime(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const statRaw = await readFile(`/proc/${pid}/stat`, "utf8");
    const fieldsAfterCommand = statRaw.slice(statRaw.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fieldsAfterCommand[19];
  } catch {
    return undefined;
  }
}

async function getCurrentPatchLockOwner(): Promise<PatchLockOwner> {
  const [pidNamespace, processStartTime] = await Promise.all([
    getCurrentPidNamespace(),
    getProcessStartTime(process.pid)
  ]);
  return {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    hostname: hostname(),
    platform: process.platform,
    ...(pidNamespace ? { pidNamespace } : {}),
    ...(processStartTime ? { processStartTime } : {})
  };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function writePatchLockOwner(lockPath: string): Promise<void> {
  await writeFile(join(lockPath, PATCH_LOCK_OWNER_FILE), `${JSON.stringify(await getCurrentPatchLockOwner())}\n`);
}

async function isSamePidScope(owner: { hostname?: unknown; platform?: unknown; pidNamespace?: unknown }): Promise<boolean> {
  if (owner.hostname !== hostname() || owner.platform !== process.platform) {
    return false;
  }
  const pidNamespace = await getCurrentPidNamespace();
  if (pidNamespace) {
    return owner.pidNamespace === pidNamespace;
  }
  return owner.pidNamespace === undefined;
}

async function isPatchLockStale(lockPath: string, staleMs: number): Promise<boolean> {
  const now = Date.now();
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  try {
    const raw = await readFile(join(lockPath, PATCH_LOCK_OWNER_FILE), "utf8");
    const owner = JSON.parse(raw) as Partial<PatchLockOwner>;
    const pid = typeof owner.pid === "number" ? owner.pid : NaN;
    const createdAtMs = typeof owner.createdAt === "string" ? Date.parse(owner.createdAt) : NaN;
    if (Number.isInteger(pid) && pid > 0 && (await isSamePidScope(owner))) {
      if (!isProcessAlive(pid)) {
        return true;
      }
      const currentStartTime = await getProcessStartTime(pid);
      if (owner.processStartTime && currentStartTime && owner.processStartTime !== currentStartTime) {
        return true;
      }
      return false;
    }
    return (Number.isFinite(createdAtMs) ? now - createdAtMs : now - lockStat.mtimeMs) > staleMs;
  } catch {
    return now - lockStat.mtimeMs > staleMs;
  }
}

async function recoverStalePatchLock(lockPath: string, staleMs: number): Promise<boolean> {
  if (!(await isPatchLockStale(lockPath, staleMs))) {
    return false;
  }
  await rm(lockPath, { recursive: true, force: true });
  return true;
}

async function acquirePatchLockRecoveryLock(lockPath: string, staleMs: number): Promise<(() => Promise<void>) | undefined> {
  const recoveryLockPath = `${lockPath}${PATCH_LOCK_RECOVERY_SUFFIX}`;
  try {
    await mkdir(recoveryLockPath);
    try {
      await writePatchLockOwner(recoveryLockPath);
    } catch (error) {
      await rm(recoveryLockPath, { recursive: true, force: true });
      throw error;
    }
    return async () => {
      await rm(recoveryLockPath, { recursive: true, force: true });
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    if (await isPatchLockStale(recoveryLockPath, staleMs)) {
      await rm(recoveryLockPath, { recursive: true, force: true });
    }
    return undefined;
  }
}

async function isPatchLockRecoveryActive(lockPath: string, staleMs: number): Promise<boolean> {
  const recoveryLockPath = `${lockPath}${PATCH_LOCK_RECOVERY_SUFFIX}`;
  try {
    await stat(recoveryLockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (await isPatchLockStale(recoveryLockPath, staleMs)) {
    await rm(recoveryLockPath, { recursive: true, force: true });
    return false;
  }
  return true;
}

async function recoverStalePatchLockIfRecoveryOwner(lockPath: string, staleMs: number): Promise<boolean> {
  const releaseRecoveryLock = await acquirePatchLockRecoveryLock(lockPath, staleMs);
  if (!releaseRecoveryLock) {
    return false;
  }
  try {
    return await recoverStalePatchLock(lockPath, staleMs);
  } finally {
    await releaseRecoveryLock();
  }
}

async function acquirePatchLock(
  id: string,
  env: NodeJS.ProcessEnv,
  options: PatchLockOptions = {}
): Promise<() => Promise<void>> {
  const lockPath = `${getSessionMetaPath(id, env)}.lock`;
  const retryMs = options.retryMs ?? PATCH_LOCK_RETRY_MS;
  const staleMs = options.staleMs ?? PATCH_LOCK_STALE_MS;
  const deadline = Date.now() + (options.timeoutMs ?? PATCH_LOCK_TIMEOUT_MS);
  await mkdir(dirname(lockPath), { recursive: true });
  while (true) {
    try {
      await mkdir(lockPath);
      if (await isPatchLockRecoveryActive(lockPath, staleMs)) {
        await rm(lockPath, { recursive: true, force: true });
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for session metadata lock: ${id}`);
        }
        await sleep(retryMs);
        continue;
      }
      try {
        await writePatchLockOwner(lockPath);
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
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
      await recoverStalePatchLockIfRecoveryOwner(lockPath, staleMs);
      await sleep(retryMs);
    }
  }
}

export async function acquireSessionMetaPatchLockForTest(
  id: string,
  env: NodeJS.ProcessEnv,
  options: PatchLockOptions
): Promise<() => Promise<void>> {
  return acquirePatchLock(id, env, options);
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
