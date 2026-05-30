import { createServer, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { getSocketPath } from "../config.js";
import { patchSessionMeta, writeSessionMeta } from "../store.js";
import type { SessionMeta } from "../types.js";
import { encodeControl, encodeData, MuxDecoder, type ControlMessage } from "./mux.js";

export function namespacedId(label: string, remoteId: string): string {
  return `${label}~${remoteId}`;
}

export function toLocalMeta(meta: SessionMeta, label: string, socketPath: string): SessionMeta {
  return {
    ...meta,
    id: namespacedId(label, meta.id),
    origin: "remote",
    clientLabel: label,
    socketPath
  };
}

interface RemoteSession {
  localId: string;
  socketPath: string;
  server: Server;
  sockets: Set<Socket>;
}

/**
 * Bridges a single inbound SSH connection (mux over stdin/stdout) to local unix
 * sockets so remote sessions appear identical to local ones. All input is
 * untrusted; an oversized/invalid mux frame tears the connection down.
 */
export async function runAcceptHandler(
  label: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): Promise<void> {
  const sessions = new Map<string, RemoteSession>();
  const decoder = new MuxDecoder();

  const send = (buf: Buffer): void => {
    output.write(buf);
  };

  async function addSession(meta: SessionMeta): Promise<void> {
    const existing = sessions.get(meta.id);
    if (existing) {
      // Re-advertised: just refresh metadata, keep the existing socket server.
      await patchSessionMeta(existing.localId, {
        status: meta.status,
        priorityReason: meta.priorityReason,
        lastActivityAt: meta.lastActivityAt
      });
      return;
    }
    const localId = namespacedId(label, meta.id);
    const socketPath = getSocketPath(localId);
    await unlink(socketPath).catch(() => {});
    await writeSessionMeta(toLocalMeta(meta, label, socketPath));
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      if (sockets.size === 1) {
        send(encodeControl({ kind: "attach", id: meta.id }));
      }
      socket.on("data", (chunk: Buffer) => send(encodeData(meta.id, chunk)));
      const cleanup = (): void => {
        sockets.delete(socket);
        if (sockets.size === 0) {
          send(encodeControl({ kind: "detach", id: meta.id }));
        }
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);
    });
    server.listen(socketPath);
    sessions.set(meta.id, { localId, socketPath, server, sockets });
  }

  async function removeSession(remoteId: string): Promise<void> {
    const session = sessions.get(remoteId);
    if (!session) return;
    for (const socket of session.sockets) socket.destroy();
    session.server.close();
    await unlink(session.socketPath).catch(() => {});
    await patchSessionMeta(session.localId, { status: "disconnected", priorityReason: "disconnected" });
    sessions.delete(remoteId);
  }

  async function handleControl(message: ControlMessage): Promise<void> {
    if (message.kind === "session-added") {
      await addSession(message.meta);
    } else if (message.kind === "session-updated") {
      const session = sessions.get(message.id);
      if (session) await patchSessionMeta(session.localId, message.patch);
    } else if (message.kind === "session-removed") {
      await removeSession(message.id);
    }
    // attach/detach are devbox-bound only; never received here.
  }

  input.on("data", (chunk: Buffer) => {
    let messages;
    try {
      messages = decoder.push(chunk);
    } catch {
      (input as { destroy?: () => void }).destroy?.();
      return;
    }
    for (const msg of messages) {
      if (msg.type === "control") {
        void handleControl(msg.message);
      } else {
        const session = sessions.get(msg.sessionId);
        if (session) {
          for (const socket of session.sockets) socket.write(msg.data);
        }
      }
    }
  });

  await new Promise<void>((resolve) => {
    const teardown = async (): Promise<void> => {
      for (const remoteId of [...sessions.keys()]) {
        await removeSession(remoteId);
      }
      resolve();
    };
    input.on("end", () => void teardown());
    input.on("close", () => void teardown());
  });
}
