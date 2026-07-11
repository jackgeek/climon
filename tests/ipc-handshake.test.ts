import { createServer } from "node:net";
import { connect } from "node:net";
import { describe, expect, it } from "bun:test";
import {
  AuthErrorCode,
  IPC_PROTOCOL_VERSION,
  NONCE_LEN,
  PROOF_LEN,
  Purpose,
  daemonProof,
  randomNonce,
  verifyClientProof,
} from "../src/ipc/auth.js";
import { FrameDecoder, FrameType, encodeFrame } from "../src/ipc/frame.js";
import { clientHandshake } from "../src/ipc/handshake.js";

/** Minimal JS daemon: runs the daemon-side handshake steps over a raw socket. */
function runDaemon(
  socket: import("node:net").Socket,
  credential: Uint8Array,
  options: { rejectWith?: AuthErrorCode } = {},
): void {
  const decoder = new FrameDecoder();
  decoder.setMaxPayload(4 * 1024);

  // Step 1: send AuthChallenge  version(1) || reserved(1)=0 || challenge_nonce(32)
  const challengeNonce = randomNonce();
  const challenge = Buffer.allocUnsafe(2 + NONCE_LEN);
  challenge[0] = IPC_PROTOCOL_VERSION;
  challenge[1] = 0;
  challenge.set(challengeNonce, 2);
  socket.write(encodeFrame(FrameType.AuthChallenge, challenge));

  socket.on("data", (chunk: Buffer) => {
    const frames = decoder.push(chunk);
    for (const frame of frames) {
      if (frame.type !== FrameType.AuthResponse) {
        socket.write(encodeFrame(FrameType.AuthError, Buffer.from([AuthErrorCode.Malformed])));
        socket.end();
        return;
      }

      const payload = frame.payload;
      if (payload.length !== 1 + NONCE_LEN + PROOF_LEN) {
        socket.write(encodeFrame(FrameType.AuthError, Buffer.from([AuthErrorCode.Malformed])));
        socket.end();
        return;
      }

      const purpose: Purpose = payload[0];
      const responseNonce = new Uint8Array(payload.subarray(1, 1 + NONCE_LEN));
      const clientProofBytes = new Uint8Array(payload.subarray(1 + NONCE_LEN));

      // If a forced rejection is requested, skip proof verification
      if (options.rejectWith !== undefined) {
        socket.write(encodeFrame(FrameType.AuthError, Buffer.from([options.rejectWith])));
        socket.end();
        return;
      }

      // Step 3a: verify client proof
      const valid = verifyClientProof(
        credential,
        IPC_PROTOCOL_VERSION,
        purpose,
        challengeNonce,
        responseNonce,
        clientProofBytes,
      );
      if (!valid) {
        socket.write(encodeFrame(FrameType.AuthError, Buffer.from([AuthErrorCode.BadProof])));
        socket.end();
        return;
      }

      // Step 3b: send AuthOk or AuthProbeOk with daemon proof
      const dproof = daemonProof(
        credential,
        IPC_PROTOCOL_VERSION,
        purpose,
        challengeNonce,
        responseNonce,
        clientProofBytes,
      );
      const okType = purpose === Purpose.Probe ? FrameType.AuthProbeOk : FrameType.AuthOk;
      socket.write(encodeFrame(okType, Buffer.from(dproof)));
    }
  });
}

function startDaemonServer(
  credential: Uint8Array,
  options: { rejectWith?: AuthErrorCode } = {},
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      runDaemon(socket, credential, options);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => server.close(),
      });
    });
    server.on("error", reject);
  });
}

function makeClientSocket(port: number): Promise<import("node:net").Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("clientHandshake", () => {
  it("resolves on a successful Session round-trip", async () => {
    const credential = new Uint8Array(32).fill(0x42);
    const { port, close } = await startDaemonServer(credential);
    try {
      const socket = await makeClientSocket(port);
      await clientHandshake(socket, credential, Purpose.Session);
      socket.destroy();
    } finally {
      close();
    }
  });

  it("resolves on a successful Probe round-trip", async () => {
    const credential = new Uint8Array(32).fill(0x07);
    const { port, close } = await startDaemonServer(credential);
    try {
      const socket = await makeClientSocket(port);
      await clientHandshake(socket, credential, Purpose.Probe);
      socket.destroy();
    } finally {
      close();
    }
  });

  it("rejects with BadProof when daemon sends AuthError BadProof (wrong credential)", async () => {
    const daemonCred = new Uint8Array(32).fill(0x01);
    const clientCred = new Uint8Array(32).fill(0x02);
    // Daemon uses its own credential; client sends wrong credential → daemon rejects
    const { port, close } = await startDaemonServer(daemonCred);
    try {
      const socket = await makeClientSocket(port);
      await expect(clientHandshake(socket, clientCred, Purpose.Session)).rejects.toMatchObject({
        code: AuthErrorCode.BadProof,
      });
      socket.destroy();
    } finally {
      close();
    }
  });
});
