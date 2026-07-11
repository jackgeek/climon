import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  IPC_PROTOCOL_VERSION,
  NONCE_LEN,
  PROOF_LEN,
  Purpose,
  daemonProof,
  randomNonce,
  verifyClientProof,
} from "../src/ipc/auth.js";
import { FrameDecoder, FrameType, encodeFrame } from "../src/ipc/frame.js";
import { connectAuthenticatedSession, formatSessionSocketRef, probeAuthenticatedSession } from "../src/session-socket.js";

const SESSION_ID = "rare-geckos-jam";
const CREDENTIAL = Uint8Array.from({ length: 32 }, (_, i) => i);
const CREDENTIAL_HEX = Buffer.from(CREDENTIAL).toString("hex");

let home: string | undefined;
let previousClimonHome: string | undefined;
let server: Server | undefined;

function runAuthDaemon(socket: Socket, trailingFrame?: Buffer): void {
  const decoder = new FrameDecoder();
  decoder.setMaxPayload(4 * 1024);
  const challengeNonce = randomNonce();
  const challenge = Buffer.allocUnsafe(2 + NONCE_LEN);
  challenge[0] = IPC_PROTOCOL_VERSION;
  challenge[1] = 0;
  challenge.set(challengeNonce, 2);
  socket.write(encodeFrame(FrameType.AuthChallenge, challenge));

  socket.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.type !== FrameType.AuthResponse || frame.payload.length !== 1 + NONCE_LEN + PROOF_LEN) {
        socket.destroy();
        return;
      }
      const purpose = frame.payload[0] as Purpose;
      const responseNonce = new Uint8Array(frame.payload.subarray(1, 1 + NONCE_LEN));
      const clientProofBytes = new Uint8Array(frame.payload.subarray(1 + NONCE_LEN));
      const valid = verifyClientProof(
        CREDENTIAL,
        IPC_PROTOCOL_VERSION,
        purpose,
        challengeNonce,
        responseNonce,
        clientProofBytes,
      );
      if (!valid) {
        socket.destroy();
        return;
      }
      const proof = daemonProof(
        CREDENTIAL,
        IPC_PROTOCOL_VERSION,
        purpose,
        challengeNonce,
        responseNonce,
        clientProofBytes,
      );
      const okType = purpose === Purpose.Probe ? FrameType.AuthProbeOk : FrameType.AuthOk;
      const ok = encodeFrame(okType, proof);
      socket.write(trailingFrame && purpose === Purpose.Session ? Buffer.concat([ok, trailingFrame]) : ok);
    }
  });
}

async function startAuthServer(trailingFrame?: Buffer): Promise<string> {
  server = createServer((socket) => runAuthDaemon(socket, trailingFrame));
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind a TCP port");
  return formatSessionSocketRef("127.0.0.1", address.port);
}

function writeSidecar(endpoint: string): string {
  if (!home) throw new Error("missing test home");
  const path = join(home, "sessions", `${SESSION_ID}.ipc-auth`);
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      generation: "0123456789abcdef0123456789abcdef",
      endpoint,
      credential: CREDENTIAL_HEX,
    }),
  );
  return path;
}

afterEach(() => {
  server?.close();
  server = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
  if (previousClimonHome === undefined) {
    delete process.env.CLIMON_HOME;
  } else {
    process.env.CLIMON_HOME = previousClimonHome;
  }
});

describe("authenticated session sockets", () => {
  test("connects with the sidecar credential and preserves bytes pipelined after AuthOk", async () => {
    previousClimonHome = process.env.CLIMON_HOME;
    home = mkdtempSync(join(process.cwd(), ".test-climon-auth-"));
    mkdirSync(join(home, "sessions"), { recursive: true });
    process.env.CLIMON_HOME = home;

    const output = encodeFrame(FrameType.Output, Buffer.from("ready", "utf8"));
    const endpoint = await startAuthServer(output);
    const sidecar = writeSidecar(endpoint);

    const session = await connectAuthenticatedSession(SESSION_ID);
    const frames = new FrameDecoder().push(session.leftover);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(FrameType.Output);
    expect(frames[0].payload.toString("utf8")).toBe("ready");
    session.socket.destroy();

    unlinkSync(sidecar);
    await expect(connectAuthenticatedSession(SESSION_ID)).rejects.toThrow(/restart/);
    expect(await probeAuthenticatedSession(SESSION_ID)).toBe(false);
  });

  test("probeAuthenticatedSession succeeds only when the daemon completes a Probe handshake", async () => {
    previousClimonHome = process.env.CLIMON_HOME;
    home = mkdtempSync(join(process.cwd(), ".test-climon-auth-"));
    mkdirSync(join(home, "sessions"), { recursive: true });
    process.env.CLIMON_HOME = home;

    const endpoint = await startAuthServer();
    const sidecar = writeSidecar(endpoint);

    expect(await probeAuthenticatedSession(SESSION_ID)).toBe(true);

    unlinkSync(sidecar);
    expect(await probeAuthenticatedSession(SESSION_ID)).toBe(false);
  });
});
