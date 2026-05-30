import { spawn, type ChildProcessByStdio } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { dirname, join } from "node:path";
import { getClimonHome, getSessionsDir, loadRemoteConfig, resolveRemoteConfigDir } from "../config.js";
import { listSessions, readSessionMeta } from "../store.js";
import { encodeControl, encodeData, MuxDecoder } from "./mux.js";

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  identityFile: string;
  knownHostsFile: string;
}

/** Hardened, non-interactive SSH flags. Host verification is mandatory and pinned. */
export function buildSshArgs(target: SshTarget): string[] {
  return [
    "-p", String(target.port),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${target.knownHostsFile}`,
    "-o", "IdentitiesOnly=yes",
    "-o", `IdentityFile=${target.identityFile}`,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "PasswordAuthentication=no",
    "-o", "PubkeyAuthentication=yes",
    "-T",
    `${target.user}@${target.host}`
  ];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Returns true if this process now owns the singleton, false if another live instance holds it. */
export async function acquireSingleton(pidFile: string): Promise<boolean> {
  try {
    const existing = await readFile(pidFile, "utf8");
    const pid = Number.parseInt(existing.trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return false;
  } catch {
    // No (or unreadable) pidfile: we may proceed.
  }
  await mkdir(dirname(pidFile), { recursive: true });
  await writeFile(pidFile, `${process.pid}\n`, { mode: 0o600 });
  return true;
}

interface Bridge {
  child: ChildProcessByStdio<Writable, Readable, null>;
  attached: Map<string, Socket>;
  advertised: Set<string>;
  watcher?: FSWatcher;
}

/** Diffs the local sessions dir against what's been advertised and emits add/remove control messages. */
async function reconcile(bridge: Bridge): Promise<void> {
  const current = new Set<string>();
  for (const meta of await listSessions()) {
    current.add(meta.id);
    bridge.child.stdin.write(encodeControl({ kind: "session-added", meta }));
  }
  bridge.advertised = bridge.advertised ?? new Set<string>();
  for (const id of bridge.advertised) {
    if (!current.has(id)) {
      bridge.child.stdin.write(encodeControl({ kind: "session-removed", id }));
    }
  }
  bridge.advertised = current;
}

function attach(bridge: Bridge, sessionId: string): void {
  if (bridge.attached.has(sessionId)) return;
  void readSessionMeta(sessionId).then((meta) => {
    if (!meta) return;
    const socket = connect(meta.socketPath);
    bridge.attached.set(sessionId, socket);
    socket.on("data", (chunk: Buffer) => bridge.child.stdin.write(encodeData(sessionId, chunk)));
    const cleanup = (): void => {
      bridge.attached.delete(sessionId);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
}

function detach(bridge: Bridge, sessionId: string): void {
  const socket = bridge.attached.get(sessionId);
  if (socket) {
    socket.destroy();
    bridge.attached.delete(sessionId);
  }
}

async function runConnection(target: SshTarget): Promise<void> {
  const child = spawn("ssh", buildSshArgs(target), { stdio: ["pipe", "pipe", "inherit"] });
  const bridge: Bridge = { child, attached: new Map(), advertised: new Set() };
  const decoder = new MuxDecoder();

  await reconcile(bridge);

  bridge.watcher = watch(getSessionsDir(), () => {
    void reconcile(bridge);
  });

  child.stdout.on("data", (chunk: Buffer) => {
    let messages;
    try {
      messages = decoder.push(chunk);
    } catch {
      child.kill();
      return;
    }
    for (const msg of messages) {
      if (msg.type === "control") {
        if (msg.message.kind === "attach") attach(bridge, msg.message.id);
        else if (msg.message.kind === "detach") detach(bridge, msg.message.id);
      } else {
        const socket = bridge.attached.get(msg.sessionId);
        if (socket) socket.write(msg.data);
      }
    }
  });

  await new Promise<void>((resolve) => {
    child.on("exit", () => {
      bridge.watcher?.close();
      for (const socket of bridge.attached.values()) socket.destroy();
      resolve();
    });
  });
}

export async function runUplink(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<number> {
  const dir = resolveRemoteConfigDir(env, cwd);
  const { remote } = await loadRemoteConfig(env, cwd);
  if (!remote?.enabled || !remote.host) return 0;

  const pidFile = join(getClimonHome(env), "uplink.pid");
  if (!(await acquireSingleton(pidFile))) return 0;

  const target: SshTarget = {
    host: remote.host,
    port: remote.port ?? 22,
    user: remote.user ?? env.USER ?? "climon",
    identityFile: remote.keyFile ?? join(dir, "id_climon"),
    knownHostsFile: join(dir, "known_hosts")
  };

  let backoffMs = 1000;
  for (;;) {
    const startedAt = Date.now();
    try {
      await runConnection(target);
    } catch {
      // fall through to backoff
    }
    // Reset backoff if the connection was healthy for a while.
    if (Date.now() - startedAt > 30_000) backoffMs = 1000;
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }
}
