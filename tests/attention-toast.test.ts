import { describe, expect, test } from "bun:test";
import type { SessionMeta } from "../src/types.js";
import { buildAttentionToast } from "../src/web/attentionToast.js";

function session(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    id: "sess-1",
    command: ["bash"],
    displayCommand: "bash",
    cwd: "/tmp",
    status: "needs-attention",
    priorityReason: "attention",
    socketPath: "/tmp/sess-1.sock",
    cols: 80,
    rows: 24,
    createdAt: "2026-06-04T10:00:00.000Z",
    updatedAt: "2026-06-04T10:00:00.000Z",
    lastActivityAt: "2026-06-04T10:00:00.000Z",
    ...overrides
  };
}

describe("buildAttentionToast", () => {
  test("uses the session name in a subtle in-app message (no climon prefix)", () => {
    const toast = buildAttentionToast(session({ name: "API server", attentionMatchedAt: "t1" }));
    expect(toast.message).toBe("API server needs attention");
    expect(toast.sessionId).toBe("sess-1");
  });

  test("falls back to display command, then command, for the label", () => {
    expect(buildAttentionToast(session({ name: "", displayCommand: "bun test" })).message).toBe(
      "bun test needs attention"
    );
    expect(
      buildAttentionToast(session({ name: "", displayCommand: "", command: ["bun", "run", "dev"] })).message
    ).toBe("bun run dev needs attention");
  });

  test("dedups by attention episode: id + attentionMatchedAt", () => {
    const a = buildAttentionToast(session({ id: "s", attentionMatchedAt: "t1" }));
    const b = buildAttentionToast(session({ id: "s", attentionMatchedAt: "t1" }));
    const c = buildAttentionToast(session({ id: "s", attentionMatchedAt: "t2" }));
    expect(a.toastId).toBe(b.toastId);
    expect(a.toastId).not.toBe(c.toastId);
  });

  test("includes the terminal title as the toast body", () => {
    const toast = buildAttentionToast(
      session({ name: "API server", terminalTitle: "vim server.ts", attentionMatchedAt: "t1" })
    );
    expect(toast.message).toBe("API server needs attention");
    expect(toast.body).toBe("vim server.ts");
  });

  test("prefers the smart snippet for the body", () => {
    const toast = buildAttentionToast(
      session({
        name: "API server",
        terminalTitle: "vim server.ts",
        attentionSnippet: "Saved. Run tests?",
        attentionMatchedAt: "t1"
      })
    );
    expect(toast.body).toBe("Saved. Run tests?");
  });

  test("omits the body when there is no terminal title", () => {
    const toast = buildAttentionToast(session({ name: "API server", attentionMatchedAt: "t1" }));
    expect(toast.body).toBeUndefined();
  });
});
