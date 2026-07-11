import { Buffer } from "node:buffer";
import type { Socket } from "node:net";
import {
  AuthErrorCode,
  IPC_PROTOCOL_VERSION,
  NONCE_LEN,
  PRE_AUTH_MAX_PAYLOAD,
  PROOF_LEN,
  Purpose,
  clientProof,
  randomNonce,
  verifyDaemonProof,
} from "./auth.js";
import { FrameDecoder, FrameType, HEADER_SIZE, encodeFrame } from "./frame.js";

/** Handshake failure — never leaks credentials or nonces in the message. */
export class HandshakeError extends Error {
  constructor(
    message: string,
    /** Set when the daemon explicitly rejected with an AuthError code. */
    public readonly code?: AuthErrorCode,
  ) {
    super(message);
    this.name = "HandshakeError";
  }
}

/**
 * Runs the 4-step client handshake over an open `net.Socket`:
 *   1. Read AuthChallenge from daemon.
 *   2. Send AuthResponse (purpose + response_nonce + client_proof).
 *   3. Read AuthOk / AuthProbeOk / AuthError from daemon.
 *   4. Verify daemon proof.
 */
export function clientHandshake(
  socket: Socket,
  credential: Uint8Array,
  purpose: Purpose,
  timeoutMs = 5000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder();
    decoder.setMaxPayload(PRE_AUTH_MAX_PAYLOAD);

    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rawIn = Buffer.alloc(0);
    let handshakeConsumed = 0;
    let responseNonce: Uint8Array | null = null;
    let cproof: Uint8Array | null = null;
    let challengeNonce: Uint8Array | null = null;
    // Which step we are waiting for next: "challenge" | "ok"
    let step: "challenge" | "ok" = "challenge";

    const fail = (err: HandshakeError): void => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    const succeed = (): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve(rawIn.subarray(handshakeConsumed));
    };

    const onData = (chunk: Buffer): void => {
      if (done) return;
      rawIn = rawIn.length === 0 ? Buffer.from(chunk) : Buffer.concat([rawIn, Buffer.from(chunk)]);
      const frames = decoder.push(chunk);
      if (decoder.errored) {
        fail(new HandshakeError("frame exceeds pre-auth payload cap"));
        return;
      }
      for (const frame of frames) {
        if (done) break;
        handshakeConsumed += HEADER_SIZE + frame.payload.length;
        handleFrame(frame.type, frame.payload);
      }
    };

    const onError = (err: Error): void => {
      fail(new HandshakeError(`socket error: ${err.message}`));
    };

    const onClose = (): void => {
      if (!done) fail(new HandshakeError("socket closed during handshake"));
    };

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    timer = setTimeout(() => fail(new HandshakeError("handshake timed out")), timeoutMs);

    const handleFrame = (type: FrameType, payload: Buffer): void => {
      if (step === "challenge") {
        // Step 1: expect AuthChallenge
        if (type !== FrameType.AuthChallenge) {
          fail(new HandshakeError("expected AuthChallenge"));
          return;
        }
        if (payload.length !== 2 + NONCE_LEN) {
          fail(new HandshakeError("bad AuthChallenge length"));
          return;
        }
        const version = payload[0];
        if (version !== IPC_PROTOCOL_VERSION) {
          fail(new HandshakeError("unsupported protocol version", AuthErrorCode.UnsupportedVersion));
          return;
        }
        challengeNonce = new Uint8Array(payload.subarray(2, 2 + NONCE_LEN));

        // Step 2: send AuthResponse
        responseNonce = randomNonce();
        cproof = clientProof(credential, IPC_PROTOCOL_VERSION, purpose, challengeNonce, responseNonce);

        const resp = Buffer.allocUnsafe(1 + NONCE_LEN + PROOF_LEN);
        resp[0] = purpose;
        resp.set(responseNonce, 1);
        resp.set(cproof, 1 + NONCE_LEN);

        try {
          socket.write(encodeFrame(FrameType.AuthResponse, resp));
        } catch (e) {
          fail(new HandshakeError(`write error: ${(e as Error).message}`));
          return;
        }

        step = "ok";
      } else {
        // Step 3: expect AuthOk / AuthProbeOk / AuthError
        if (type === FrameType.AuthError) {
          const code =
            payload.length >= 1
              ? (payload[0] as AuthErrorCode)
              : AuthErrorCode.Malformed;
          fail(new HandshakeError("authentication rejected", code));
          return;
        }
        if (type !== FrameType.AuthOk && type !== FrameType.AuthProbeOk) {
          fail(new HandshakeError("expected AuthOk"));
          return;
        }
        if (payload.length !== PROOF_LEN) {
          fail(new HandshakeError("bad AuthOk length"));
          return;
        }

        // Step 4: verify daemon proof
        const ok = verifyDaemonProof(
          credential,
          IPC_PROTOCOL_VERSION,
          purpose,
          challengeNonce!,
          responseNonce!,
          cproof!,
          new Uint8Array(payload),
        );
        if (!ok) {
          fail(new HandshakeError("bad daemon proof"));
          return;
        }
        succeed();
      }
    };
  });
}
