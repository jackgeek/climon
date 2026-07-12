import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("dashboard server attach failures", () => {
  test("sends a JSON error frame to the browser before closing failed attaches", () => {
    const source = readFileSync("src/server/server.ts", "utf8");

    expect(source).toContain('logMsg(getLogger(), "warn", "server.attach_failed"');
    expect(source).toContain('ws.send(JSON.stringify({ type: "error", message: reason }))');
    expect(source).toContain("ws.close();");
  });

  test("catalogs the attach failure warning with unredacted non-sensitive params", () => {
    const messages = JSON.parse(readFileSync("src/i18n/messages.en.json", "utf8"));

    expect(messages["server.attach_failed"]).toMatchObject({
      t: "attach failed for session {sessionId}: {reason}",
      hint:
        "Warning logged when the dashboard server could not open an authenticated IPC connection to a session's daemon or proxy for a browser attach; {sessionId} is the local session ID and {reason} is a short non-sensitive failure description shown to the user.",
      params: {
        sessionId: { redact: false, category: "generic" },
        reason: { redact: false, category: "generic" }
      }
    });
    expect(messages["server.attach_failed"].id).toMatch(/^[0-9a-f]{8}$/);
  });
});
