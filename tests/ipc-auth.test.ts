import { describe, expect, test } from "bun:test";
import {
  Purpose,
  IPC_PROTOCOL_VERSION,
  clientProof,
  daemonProof,
  verifyClientProof,
  verifyDaemonProof,
} from "../src/ipc/auth.js";

const CRED = new Uint8Array(32).fill(7);
const CHALLENGE = new Uint8Array(32).fill(1);
const RESPONSE = new Uint8Array(32).fill(2);

describe("ipc auth proofs", () => {
  test("client and daemon proofs are domain-separated", () => {
    const cp = clientProof(CRED, IPC_PROTOCOL_VERSION, Purpose.Session, CHALLENGE, RESPONSE);
    const dp = daemonProof(CRED, IPC_PROTOCOL_VERSION, Purpose.Session, CHALLENGE, RESPONSE, cp);
    expect(Buffer.from(cp).equals(Buffer.from(dp))).toBe(false);
  });

  test("matches the Rust reference vector", () => {
    const cp = clientProof(CRED, IPC_PROTOCOL_VERSION, Purpose.Session, CHALLENGE, RESPONSE);
    expect(Buffer.from(cp).toString("hex")).toBe("6460bacc53b88e0fb3e4b877688732a9a67bf7dc0eee32b9e1bd7e658f66f276");
  });

  test("verify accepts valid client and daemon proofs", () => {
    const cp = clientProof(CRED, IPC_PROTOCOL_VERSION, Purpose.Session, CHALLENGE, RESPONSE);
    const dp = daemonProof(CRED, IPC_PROTOCOL_VERSION, Purpose.Session, CHALLENGE, RESPONSE, cp);
    expect(verifyClientProof(CRED, IPC_PROTOCOL_VERSION, Purpose.Session, CHALLENGE, RESPONSE, cp)).toBe(true);
    expect(verifyDaemonProof(CRED, IPC_PROTOCOL_VERSION, Purpose.Session, CHALLENGE, RESPONSE, cp, dp)).toBe(true);
  });

  test("verify rejects a tampered proof", () => {
    const cp = clientProof(CRED, IPC_PROTOCOL_VERSION, Purpose.Session, CHALLENGE, RESPONSE);
    const bad = Uint8Array.from(cp);
    bad[0] ^= 0xff;
    expect(verifyClientProof(CRED, IPC_PROTOCOL_VERSION, Purpose.Session, CHALLENGE, RESPONSE, bad)).toBe(false);
  });

  test("verify rejects a wrong-length candidate without throwing", () => {
    expect(verifyClientProof(CRED, IPC_PROTOCOL_VERSION, Purpose.Session, CHALLENGE, RESPONSE, new Uint8Array(8))).toBe(false);
  });
});
