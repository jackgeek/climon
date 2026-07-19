import { expect, test } from "@playwright/test";
import {
  parseHeadlessStdout,
  SESSION_ID_RE,
  SCENARIOS,
  classifyError,
} from "../src/scenarios.js";
import { HarnessError, type ScenarioKey } from "../src/types.js";

// ── parseHeadlessStdout ─────────────────────────────────────────────────────

test("parseHeadlessStdout: extracts session ID from single-line stdout", () => {
  const id = parseHeadlessStdout("abc-123-def\n");
  expect(id).toBe("abc-123-def");
});

test("parseHeadlessStdout: trims surrounding whitespace", () => {
  const id = parseHeadlessStdout("  session-xyz  \n");
  expect(id).toBe("session-xyz");
});

test("parseHeadlessStdout: handles bare ID without trailing newline", () => {
  const id = parseHeadlessStdout("my_session");
  expect(id).toBe("my_session");
});

test("parseHeadlessStdout: accepts UUID-style session ID", () => {
  const id = parseHeadlessStdout(
    "550e8400-e29b-41d4-a716-446655440000\n"
  );
  expect(id).toBe("550e8400-e29b-41d4-a716-446655440000");
});

test("parseHeadlessStdout: rejects empty stdout", () => {
  expect(() => parseHeadlessStdout("")).toThrow(HarnessError);
  expect(() => parseHeadlessStdout("")).toThrow("no stdout");
});

test("parseHeadlessStdout: rejects whitespace-only stdout", () => {
  expect(() => parseHeadlessStdout("   \n  \n  ")).toThrow(HarnessError);
  expect(() => parseHeadlessStdout("   \n  \n  ")).toThrow("no stdout");
});

test("parseHeadlessStdout: rejects multi-line stdout", () => {
  expect(() => parseHeadlessStdout("line1\nline2\n")).toThrow(HarnessError);
  expect(() => parseHeadlessStdout("line1\nline2\n")).toThrow("exactly one");
});

test("parseHeadlessStdout: rejects unsafe characters in session ID", () => {
  expect(() => parseHeadlessStdout("session id with spaces\n")).toThrow(
    HarnessError
  );
  expect(() => parseHeadlessStdout("session id with spaces\n")).toThrow(
    "unsafe"
  );
});

test("parseHeadlessStdout: rejects control characters", () => {
  expect(() => parseHeadlessStdout("abc\x00def\n")).toThrow(HarnessError);
});

// ── SESSION_ID_RE ───────────────────────────────────────────────────────────

test("SESSION_ID_RE: matches alphanumeric with hyphens and underscores", () => {
  expect(SESSION_ID_RE.test("abc-123_DEF")).toBe(true);
});

test("SESSION_ID_RE: rejects spaces", () => {
  expect(SESSION_ID_RE.test("abc def")).toBe(false);
});

test("SESSION_ID_RE: rejects control characters", () => {
  expect(SESSION_ID_RE.test("abc\x00def")).toBe(false);
});

test("SESSION_ID_RE: rejects empty string", () => {
  expect(SESSION_ID_RE.test("")).toBe(false);
});

// ── SCENARIOS registry ──────────────────────────────────────────────────────

test("SCENARIOS has entry for every ScenarioKey", () => {
  const keys: ScenarioKey[] = [
    "client-server.headless-dashboard",
    "client-server.attached-pty",
  ];
  for (const key of keys) {
    expect(SCENARIOS[key]).toBeDefined();
    expect(typeof SCENARIOS[key]).toBe("function");
  }
});

test("SCENARIOS has exactly two entries", () => {
  expect(Object.keys(SCENARIOS)).toHaveLength(2);
});

// ── classifyError ───────────────────────────────────────────────────────────

test("classifyError: extracts kind from HarnessError", () => {
  const err = new HarnessError("browser", "page not found");
  const result = classifyError(err);
  expect(result.kind).toBe("browser");
  expect(result.message).toBe("page not found");
});

test("classifyError: infers timeout from message", () => {
  const err = new Error("operation timeout exceeded");
  const result = classifyError(err);
  expect(result.kind).toBe("timeout");
});

test("classifyError: defaults to assertion for unknown errors", () => {
  const result = classifyError(new Error("something went wrong"));
  expect(result.kind).toBe("assertion");
});

test("classifyError: handles non-Error values", () => {
  const result = classifyError("string error");
  expect(result.kind).toBe("assertion");
  expect(result.message).toBe("string error");
});

test("classifyError: handles every HarnessError kind", () => {
  for (const kind of [
    "build",
    "server-startup",
    "client-startup",
    "pty",
    "browser",
    "assertion",
    "timeout",
    "cleanup",
  ] as const) {
    const result = classifyError(new HarnessError(kind, `test ${kind}`));
    expect(result.kind).toBe(kind);
  }
});
