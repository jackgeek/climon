import { randomUUID } from "node:crypto";
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
const PATCH_LOCK_RECLAIM_CLAIM_FILE = ".reclaiming.json";

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
  token: string;
  pidNamespace?: string;
  processStartTime?: string;
};

type PatchLockIdentity = {
  dev: number;
  ino: number;
};

type PatchLockInstance = {
  identity: PatchLockIdentity;
  owner: PatchLockOwner;
};

type PatchLockSnapshot = {
  identity: PatchLockIdentity;
  mtimeMs: number;
  owner: Partial<PatchLockOwner> | undefined;
  ownerRaw: string | undefined;
};

type PatchLockTestHooks = {
  afterReleaseRename?: (paths: { lockPath: string; releasePath: string }) => Promise<void> | void;
  beforeQuarantineRename?: (paths: { lockPath: string }) => Promise<void> | void;
  afterQuarantineSnapshot?: (paths: { lockPath: string }) => Promise<void> | void;
  beforeQuarantineRenameAfterValidation?: (paths: { lockPath: string }) => Promise<void> | void;
  afterQuarantineRename?: (paths: { lockPath: string; quarantinePath: string }) => Promise<void> | void;
};

let patchLockTestHooks: PatchLockTestHooks = {};

export function setPatchLockTestHooksForTest(hooks: PatchLockTestHooks): () => void {
  patchLockTestHooks = hooks;
  return () => {
    patchLockTestHooks = {};
  };
}

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
    token: randomUUID(),
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

async function writePatchLockOwner(lockPath: string, owner: PatchLockOwner): Promise<void> {
  await writeFile(join(lockPath, PATCH_LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`);
}

async function readPatchLockOwner(lockPath: string): Promise<Partial<PatchLockOwner> | undefined> {
  return readPatchLockOwnerFile(join(lockPath, PATCH_LOCK_OWNER_FILE));
}

async function readPatchLockOwnerFile(path: string): Promise<Partial<PatchLockOwner> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Partial<PatchLockOwner>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function isSamePatchLockOwner(actual: Partial<PatchLockOwner> | undefined, expected: PatchLockOwner): boolean {
  return actual?.token === expected.token;
}

function isSamePatchLockIdentity(actual: PatchLockIdentity, expected: PatchLockIdentity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

async function getPatchLockIdentity(lockPath: string): Promise<PatchLockIdentity> {
  const lockStat = await stat(lockPath);
  return { dev: lockStat.dev, ino: lockStat.ino };
}

async function getPatchLockSnapshot(lockPath: string): Promise<PatchLockSnapshot | undefined> {
  try {
    const lockStat = await stat(lockPath);
    let ownerRaw: string | undefined;
    let owner: Partial<PatchLockOwner> | undefined;
    try {
      ownerRaw = await readFile(join(lockPath, PATCH_LOCK_OWNER_FILE), "utf8");
      try {
        owner = JSON.parse(ownerRaw) as Partial<PatchLockOwner>;
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return { identity: { dev: lockStat.dev, ino: lockStat.ino }, mtimeMs: lockStat.mtimeMs, owner, ownerRaw };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isSamePatchLockSnapshot(
  actual: Partial<PatchLockOwner> | undefined,
  expected: Partial<PatchLockOwner> | undefined
): boolean {
  if (!actual || !expected) {
    return actual === expected;
  }
  if (typeof actual.token === "string" || typeof expected.token === "string") {
    return actual.token === expected.token;
  }
  return (
    actual.pid === expected.pid &&
    actual.createdAt === expected.createdAt &&
    actual.hostname === expected.hostname &&
    actual.platform === expected.platform &&
    actual.pidNamespace === expected.pidNamespace &&
    actual.processStartTime === expected.processStartTime
  );
}

function isSamePatchLockReclaimSnapshot(
  actual: PatchLockSnapshot | undefined,
  expected: PatchLockSnapshot | undefined
): boolean {
  return (
    actual !== undefined &&
    expected !== undefined &&
    isSamePatchLockIdentity(actual.identity, expected.identity) &&
    actual.ownerRaw === expected.ownerRaw &&
    isSamePatchLockSnapshot(actual.owner, expected.owner)
  );
}

async function releasePatchLock(lockPath: string, instance: PatchLockInstance): Promise<void> {
  let currentIdentity: PatchLockIdentity;
  try {
    currentIdentity = await getPatchLockIdentity(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const currentOwner = await readPatchLockOwner(lockPath);
  if (!isSamePatchLockIdentity(currentIdentity, instance.identity) || !isSamePatchLockOwner(currentOwner, instance.owner)) {
    return;
  }

  const releasePath = `${lockPath}.release-${process.pid}-${Date.now()}-${tempCounter++}`;
  try {
    await rename(lockPath, releasePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    if (code === "EACCES" || code === "EPERM") {
      let retryIdentity: PatchLockIdentity;
      try {
        retryIdentity = await getPatchLockIdentity(lockPath);
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code === "ENOENT") {
          return;
        }
        throw retryError;
      }
      const retryOwner = await readPatchLockOwner(lockPath);
      if (isSamePatchLockIdentity(retryIdentity, instance.identity) && isSamePatchLockOwner(retryOwner, instance.owner)) {
        await rm(lockPath, { recursive: true, force: true });
      }
      return;
    }
    throw error;
  }

  await patchLockTestHooks.afterReleaseRename?.({ lockPath, releasePath });

  const releaseIdentity = await getPatchLockIdentity(releasePath);
  const releaseOwner = await readPatchLockOwner(releasePath);
  if (!isSamePatchLockIdentity(releaseIdentity, instance.identity) || !isSamePatchLockOwner(releaseOwner, instance.owner)) {
    return;
  }
  await rm(releasePath, { recursive: true, force: true });
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

async function isPatchLockSnapshotStale(snapshot: PatchLockSnapshot, staleMs: number): Promise<boolean> {
  const now = Date.now();
  const owner = snapshot.owner;
  const pid = typeof owner?.pid === "number" ? owner.pid : NaN;
  const createdAtMs = typeof owner?.createdAt === "string" ? Date.parse(owner.createdAt) : NaN;
  if (owner && Number.isInteger(pid) && pid > 0 && (await isSamePidScope(owner))) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    const currentStartTime = await getProcessStartTime(pid);
    if (owner.processStartTime && currentStartTime && owner.processStartTime !== currentStartTime) {
      return true;
    }
    return false;
  }
  return (Number.isFinite(createdAtMs) ? now - createdAtMs : now - snapshot.mtimeMs) > staleMs;
}

async function claimPatchLockForReclaim(lockPath: string): Promise<PatchLockOwner | undefined> {
  const claim = await getCurrentPatchLockOwner();
  try {
    // Cooperating stale-reclaim paths must hold this claim before final
    // validation and rename. An existing claim means another reclaimer owns the
    // validation->rename window, so contenders must wait instead of replacing
    // the lock path.
    await writeFile(join(lockPath, PATCH_LOCK_RECLAIM_CLAIM_FILE), `${JSON.stringify(claim)}\n`, { flag: "wx" });
    return claim;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function isSamePatchLockReclaimClaim(lockPath: string, expected: PatchLockOwner): Promise<boolean> {
  const actual = await readPatchLockOwnerFile(join(lockPath, PATCH_LOCK_RECLAIM_CLAIM_FILE));
  return isSamePatchLockOwner(actual, expected);
}

async function releasePatchLockReclaimClaim(lockPath: string, claim: PatchLockOwner): Promise<void> {
  if (await isSamePatchLockReclaimClaim(lockPath, claim)) {
    await rm(join(lockPath, PATCH_LOCK_RECLAIM_CLAIM_FILE), { force: true });
  }
}

async function quarantineStalePatchLock(lockPath: string, staleMs: number): Promise<boolean> {
  const staleSnapshot = await getPatchLockSnapshot(lockPath);
  if (!staleSnapshot) {
    return false;
  }
  if (!(await isPatchLockSnapshotStale(staleSnapshot, staleMs))) {
    return false;
  }
  await patchLockTestHooks.beforeQuarantineRename?.({ lockPath });
  const preRenameSnapshot = await getPatchLockSnapshot(lockPath);
  if (
    !preRenameSnapshot ||
    !isSamePatchLockReclaimSnapshot(preRenameSnapshot, staleSnapshot) ||
    !(await isPatchLockSnapshotStale(preRenameSnapshot, staleMs))
  ) {
    return false;
  }
  const reclaimClaim = await claimPatchLockForReclaim(lockPath);
  if (!reclaimClaim) {
    return false;
  }
  let quarantinePath = "";
  let renamed = false;
  try {
    await patchLockTestHooks.afterQuarantineSnapshot?.({ lockPath });
    const claimedSnapshot = await getPatchLockSnapshot(lockPath);
    if (
      !isSamePatchLockReclaimSnapshot(claimedSnapshot, preRenameSnapshot) ||
      !(await isPatchLockSnapshotStale(preRenameSnapshot, staleMs)) ||
      !(await isSamePatchLockReclaimClaim(lockPath, reclaimClaim))
    ) {
      return false;
    }
    await patchLockTestHooks.beforeQuarantineRenameAfterValidation?.({ lockPath });
    while (true) {
      quarantinePath = `${lockPath}.stale-${process.pid}-${Date.now()}-${tempCounter++}`;
      try {
        await rename(lockPath, quarantinePath);
        renamed = true;
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  } finally {
    if (!renamed) {
      await releasePatchLockReclaimClaim(lockPath, reclaimClaim);
    }
  }
  await patchLockTestHooks.afterQuarantineRename?.({ lockPath, quarantinePath });

  const quarantineSnapshot = await getPatchLockSnapshot(quarantinePath);
  if (
    !isSamePatchLockReclaimSnapshot(quarantineSnapshot, preRenameSnapshot) ||
    !(await isPatchLockSnapshotStale(preRenameSnapshot, staleMs))
  ) {
    return false;
  }
  await rm(quarantinePath, { recursive: true, force: true });
  return true;
}

async function acquirePatchLockRecoveryLock(lockPath: string, staleMs: number): Promise<(() => Promise<void>) | undefined> {
  const recoveryLockPath = `${lockPath}${PATCH_LOCK_RECOVERY_SUFFIX}`;
  try {
    await mkdir(recoveryLockPath);
    const owner = await getCurrentPatchLockOwner();
    try {
      await writePatchLockOwner(recoveryLockPath, owner);
    } catch (error) {
      await rm(recoveryLockPath, { recursive: true, force: true });
      throw error;
    }
    const identity = await getPatchLockIdentity(recoveryLockPath);
    return async () => {
      await releasePatchLock(recoveryLockPath, { identity, owner });
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    await quarantineStalePatchLock(recoveryLockPath, staleMs);
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
  if (await quarantineStalePatchLock(recoveryLockPath, staleMs)) {
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
    return await quarantineStalePatchLock(lockPath, staleMs);
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
      const owner = await getCurrentPatchLockOwner();
      try {
        await writePatchLockOwner(lockPath, owner);
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      const identity = await getPatchLockIdentity(lockPath);
      return async () => {
        await releasePatchLock(lockPath, { identity, owner });
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
