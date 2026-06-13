import { describe, expect, test } from "bun:test";
import { parsePushData } from "../src/web/pwa/pushData.js";

describe("parsePushData", () => {
  test("parses a well-formed payload", () => {
    const data = parsePushData(JSON.stringify({ title: "climon needs attention", body: "deploy needs attention", sessionId: "s1" }));
    expect(data.title).toBe("climon needs attention");
    expect(data.body).toBe("deploy needs attention");
    expect(data.sessionId).toBe("s1");
  });

  test("falls back to defaults for empty or invalid input", () => {
    const data = parsePushData("");
    expect(data.title).toBe("climon");
    expect(data.body).toBe("A session needs attention");
    expect(data.sessionId).toBeUndefined();
  });

  test("falls back when JSON is malformed", () => {
    const data = parsePushData("{not json");
    expect(data.title).toBe("climon");
  });
});
