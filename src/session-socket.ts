import { rm } from "node:fs/promises";
import type { Buffer } from "node:buffer";
import { createServer, connect, type Server, type Socket } from "node:net";
import { Purpose } from "./ipc/auth.js";
import { clientHandshake } from "./ipc/handshake.js";
import { credentialBytes, readIpcAuthRecord } from "./ipc/ipc-auth-store.js";

export interface TcpSessionSocket {
  host: string;
  port: number;
}

export type SessionSocketRef = string;

function isTcpSocketRef(ref: string): boolean {
  try {
    return new URL(ref).protocol === "tcp:";
  } catch {
    return false;
  }
}

export function formatSessionSocketRef(host: string, port: number): string {
  const normalizedHost = host.includes(":") ? `[${host}]` : host;
  return `tcp://${normalizedHost}:${port}`;
}

export function parseSessionSocketRef(ref: SessionSocketRef): TcpSessionSocket | { path: string } {
  if (isTcpSocketRef(ref)) {
    const url = new URL(ref);
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 0) {
      throw new Error(`Invalid session socket port in ${ref}`);
    }
    return { host: url.hostname, port };
  }
  return { path: ref };
}

export function isResolvedSessionSocketRef(ref: SessionSocketRef): boolean {
  const parsed = parseSessionSocketRef(ref);
  return "path" in parsed || parsed.port > 0;
}

export function connectSessionSocket(ref: SessionSocketRef): Socket {
  const parsed = parseSessionSocketRef(ref);
  return "path" in parsed ? connect(parsed.path) : connect(parsed.port, parsed.host);
}

function waitForConnect(socket: Socket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onConnect = (): void => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (err: Error): void => {
      socket.off("connect", onConnect);
      reject(err);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

export interface AuthenticatedSession {
  socket: Socket;
  /** Bytes the daemon pipelined AFTER AuthOk; feed these into the consumer's
   * FrameDecoder before reading further from the socket. */
  leftover: Buffer;
}

/** Reads the session credential, connects, and completes the Session handshake.
 * Rejects with an actionable error if the sidecar is missing (legacy daemon). */
export async function connectAuthenticatedSession(id: string): Promise<AuthenticatedSession> {
  const record = await readIpcAuthRecord(id);
  if (!record) {
    throw new Error(
      `Session '${id}' has no IPC credential. It was started by an older, unauthenticated climon. Stop and restart the session to upgrade.`,
    );
  }
  const credential = credentialBytes(record);
  const socket = connectSessionSocket(record.endpoint);
  try {
    await waitForConnect(socket);
    const leftover = await clientHandshake(socket, credential, Purpose.Session);
    return { socket, leftover };
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

/** Liveness probe: true only if the daemon authenticates a Probe handshake. */
export async function probeAuthenticatedSession(id: string, timeoutMs = 2000): Promise<boolean> {
  let record;
  try {
    record = await readIpcAuthRecord(id);
  } catch {
    return false;
  }
  if (!record) return false;
  const credential = credentialBytes(record);
  const socket = connectSessionSocket(record.endpoint);
  try {
    await waitForConnect(socket);
    await clientHandshake(socket, credential, Purpose.Probe, timeoutMs);
    return true;
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
}

export async function waitForSessionSocket(ref: SessionSocketRef, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connectSessionSocket(ref);
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 1000);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.end();
        resolve(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for session socket at ${ref}`);
}

export async function waitForResolvedSessionSocketRef(
  getRef: () => Promise<SessionSocketRef | undefined>,
  timeoutMs = 10_000
): Promise<SessionSocketRef> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ref = await getRef();
    if (!ref) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (!isResolvedSessionSocketRef(ref)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    try {
      await waitForSessionSocket(ref, Math.min(1000, Math.max(deadline - Date.now(), 0)));
      return ref;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Timed out waiting for session socket to become ready");
}

export async function allocateLoopbackPort(host = "127.0.0.1"): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function listenOnSessionSocket(server: Server, ref: SessionSocketRef): Promise<SessionSocketRef> {
  const parsed = parseSessionSocketRef(ref);
  if ("path" in parsed) {
    await rm(parsed.path, { force: true }).catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(parsed.path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return parsed.path;
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(parsed.port, parsed.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address === "object" && address) {
    return formatSessionSocketRef(address.address, address.port);
  }
  return ref;
}

export async function cleanupSessionSocket(ref: SessionSocketRef): Promise<void> {
  const parsed = parseSessionSocketRef(ref);
  if ("path" in parsed) {
    await rm(parsed.path, { force: true }).catch(() => undefined);
  }
}
