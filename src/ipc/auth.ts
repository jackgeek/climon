import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Current session-IPC protocol version. Mirrors Rust `IPC_PROTOCOL_VERSION`. */
export const IPC_PROTOCOL_VERSION = 1;

export const CLIENT_PROOF_LABEL = Buffer.from("climon-session-ipc-v1/client-proof\0", "latin1");
export const DAEMON_PROOF_LABEL = Buffer.from("climon-session-ipc-v1/daemon-proof\0", "latin1");

export const NONCE_LEN = 32;
export const CREDENTIAL_LEN = 32;
export const PROOF_LEN = 32;

export const PRE_AUTH_MAX_PAYLOAD = 4 * 1024;
export const POST_AUTH_MAX_PAYLOAD = 8 * 1024 * 1024;
export const MAX_PENDING_HANDSHAKES = 32;

export enum Purpose {
  Session = 0x01,
  Probe = 0x02,
}

export enum AuthErrorCode {
  UnsupportedVersion = 1,
  BadProof = 2,
  Malformed = 3,
  TooManyPending = 4,
}

function proof(
  label: Buffer,
  credential: Uint8Array,
  version: number,
  purpose: Purpose,
  challengeNonce: Uint8Array,
  responseNonce: Uint8Array,
  clientProofBytes?: Uint8Array,
): Uint8Array {
  const mac = createHmac("sha256", Buffer.from(credential));
  mac.update(label);
  mac.update(Buffer.from([version, purpose]));
  mac.update(Buffer.from(challengeNonce));
  mac.update(Buffer.from(responseNonce));
  if (clientProofBytes) {
    mac.update(Buffer.from(clientProofBytes));
  }
  return new Uint8Array(mac.digest());
}

export function clientProof(
  credential: Uint8Array,
  version: number,
  purpose: Purpose,
  challengeNonce: Uint8Array,
  responseNonce: Uint8Array,
): Uint8Array {
  return proof(CLIENT_PROOF_LABEL, credential, version, purpose, challengeNonce, responseNonce);
}

export function daemonProof(
  credential: Uint8Array,
  version: number,
  purpose: Purpose,
  challengeNonce: Uint8Array,
  responseNonce: Uint8Array,
  clientProofBytes: Uint8Array,
): Uint8Array {
  return proof(DAEMON_PROOF_LABEL, credential, version, purpose, challengeNonce, responseNonce, clientProofBytes);
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function verifyClientProof(
  credential: Uint8Array,
  version: number,
  purpose: Purpose,
  challengeNonce: Uint8Array,
  responseNonce: Uint8Array,
  candidate: Uint8Array,
): boolean {
  return constantTimeEquals(clientProof(credential, version, purpose, challengeNonce, responseNonce), candidate);
}

export function verifyDaemonProof(
  credential: Uint8Array,
  version: number,
  purpose: Purpose,
  challengeNonce: Uint8Array,
  responseNonce: Uint8Array,
  clientProofBytes: Uint8Array,
  candidate: Uint8Array,
): boolean {
  return constantTimeEquals(
    daemonProof(credential, version, purpose, challengeNonce, responseNonce, clientProofBytes),
    candidate,
  );
}

export function randomNonce(): Uint8Array {
  return new Uint8Array(randomBytes(NONCE_LEN));
}
