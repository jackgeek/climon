import { test, expect } from "bun:test";
import {
  signControl,
  signNow,
  verifySignedControl,
  ReplayGuard,
  newNonce,
  DEFAULT_FRESHNESS_WINDOW_MS
} from "../src/remote/spawn-auth.js";
import type { ControlMessage } from "../src/remote/mux.js";

const ping: ControlMessage = { kind: "ping" };

test("round-trips a valid signed control", () => {
  const guard = new ReplayGuard(DEFAULT_FRESHNESS_WINDOW_MS);
  const env = signControl("sekret", ping, "nonce-1", 1000);
  const res = verifySignedControl("sekret", env, guard, 1000);
  expect(res).toEqual({ ok: true, message: ping });
});

test("rejects a forged signature", () => {
  const guard = new ReplayGuard(DEFAULT_FRESHNESS_WINDOW_MS);
  const env = signControl("sekret", ping, "nonce-1", 1000);
  expect(verifySignedControl("wrong-secret", env, guard, 1000)).toEqual({
    ok: false,
    reason: "bad-signature"
  });
});

test("rejects a stale timestamp", () => {
  const guard = new ReplayGuard(30000);
  const env = signControl("sekret", ping, "nonce-1", 1000);
  expect(verifySignedControl("sekret", env, guard, 1000 + 30001)).toEqual({
    ok: false,
    reason: "stale"
  });
});

test("rejects a replayed nonce", () => {
  const guard = new ReplayGuard(30000);
  const env = signControl("sekret", ping, "nonce-1", 1000);
  expect(verifySignedControl("sekret", env, guard, 1000).ok).toBe(true);
  expect(verifySignedControl("sekret", env, guard, 1001)).toEqual({
    ok: false,
    reason: "replay"
  });
});

test("rejects a non-signed envelope", () => {
  const guard = new ReplayGuard(30000);
  expect(verifySignedControl("sekret", ping, guard, 0)).toEqual({
    ok: false,
    reason: "not-signed"
  });
});

test("newNonce is 32 hex chars and unique", () => {
  const a = newNonce();
  const b = newNonce();
  expect(a).toMatch(/^[0-9a-f]{32}$/);
  expect(a).not.toBe(b);
});

test("signature is stable for fixed payload/nonce/ts (cross-impl pin)", () => {
  // payload = JSON.stringify({kind:"ping"}) = '{"kind":"ping"}'
  // signing input = '{"kind":"ping"}\nnonce-1\n1000'
  // HMAC-SHA256(key="sekret") hex — pinned so Bun and Rust agree.
  const env = signControl("sekret", ping, "nonce-1", 1000) as Extract<
    ControlMessage,
    { kind: "signed" }
  >;
  expect(env.payload).toBe('{"kind":"ping"}');
  expect(env.sig).toBe("cf7054af7f0345dcb46571ec4cce6174c1411a68261e8d523ff2bac185f37aa7");
});

test("signNow produces a verifiable envelope with the current time", () => {
  const guard = new ReplayGuard(30000);
  const now = 1_718_900_000_000;
  const env = signNow("sekret", ping, now);
  expect(verifySignedControl("sekret", env, guard, now).ok).toBe(true);
});
