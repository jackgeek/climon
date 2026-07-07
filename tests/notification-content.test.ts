import { describe, expect, test } from "bun:test";
import type { SessionMeta } from "../src/types.js";
import { notificationBody, notificationTitle } from "../src/notification-content.js";

function session(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    id: "s1",
    command: ["bash"],
    displayCommand: "bash",
    cwd: "/tmp",
    status: "needs-attention",
    priorityReason: "attention",
    socketPath: "/tmp/s1.sock",
    cols: 80,
    rows: 24,
    createdAt: "t",
    updatedAt: "t",
    lastActivityAt: "t",
    ...overrides
  } as SessionMeta;
}

describe("notificationTitle", () => {
  test("prefers the session name", () => {
    expect(notificationTitle(session({ name: "API server", terminalTitle: "vim" }))).toBe("API server");
  });
  test("falls back to the terminal title when name is empty", () => {
    expect(notificationTitle(session({ name: "", terminalTitle: "npm run deploy" }))).toBe("npm run deploy");
  });
  test("falls back to display command, then command", () => {
    expect(notificationTitle(session({ name: "", terminalTitle: "", displayCommand: "bun test" }))).toBe("bun test");
    expect(
      notificationTitle(session({ name: "", terminalTitle: "", displayCommand: "", command: ["bun", "run", "dev"] }))
    ).toBe("bun run dev");
  });
});

describe("notificationBody", () => {
  test("uses the snippet when present", () => {
    expect(notificationBody(session({ name: "API server", attentionSnippet: "12 tests pass. Deploy?" }))).toBe(
      "12 tests pass. Deploy?"
    );
  });
  test("falls back to the terminal title when it was not promoted into the title", () => {
    expect(notificationBody(session({ name: "API server", terminalTitle: "vim server.ts" }))).toBe("vim server.ts");
  });
  test("is empty when the terminal title was promoted into the title", () => {
    expect(notificationBody(session({ name: "", terminalTitle: "npm run deploy" }))).toBe("");
  });
  test("is empty when there is neither snippet nor title", () => {
    expect(notificationBody(session({ name: "API server" }))).toBe("");
  });
  test("prefers the snippet even when a terminal title exists", () => {
    expect(
      notificationBody(session({ name: "", terminalTitle: "npm run deploy", attentionSnippet: "done. Ship it?" }))
    ).toBe("done. Ship it?");
  });
});
