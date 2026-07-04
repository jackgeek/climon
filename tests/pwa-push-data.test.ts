import { describe, expect, test } from "bun:test";
import {
  parsePushData,
  buildNotificationOptions,
  notificationTargetPath,
  parseSessionFromSearch,
  parseOpenSessionMessage,
  OPEN_SESSION_MESSAGE,
} from "../src/web/pwa/pushData.js";

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

  test("preserves an explicit empty body so only the title shows", () => {
    const data = parsePushData(JSON.stringify({ title: "climon session deploy needs attention", body: "", sessionId: "s1" }));
    expect(data.title).toBe("climon session deploy needs attention");
    expect(data.body).toBe("");
  });
});

describe("buildNotificationOptions", () => {
  test("requests sound/haptics so the device alerts the user", () => {
    const options = buildNotificationOptions({ title: "t", body: "deploy needs attention", sessionId: "s1" });
    expect(options.silent).toBe(false);
    expect(options.renotify).toBe(true);
    expect(Array.isArray(options.vibrate)).toBe(true);
    expect((options.vibrate ?? []).length).toBeGreaterThan(0);
  });

  test("carries the session id and a per-session tag", () => {
    const options = buildNotificationOptions({ title: "t", body: "b", sessionId: "s1" });
    expect(options.tag).toBe("climon-s1");
    expect((options.data as { sessionId?: string }).sessionId).toBe("s1");
  });

  test("uses a stable tag when there is no session id", () => {
    const options = buildNotificationOptions({ title: "t", body: "b" });
    expect(options.tag).toBe("climon");
  });
});

describe("notificationTargetPath", () => {
  test("deep-links to a specific session", () => {
    expect(notificationTargetPath("s1")).toBe("/?session=s1");
  });

  test("encodes session ids", () => {
    expect(notificationTargetPath("host~a b")).toBe("/?session=host~a%20b");
  });

  test("falls back to root with no session", () => {
    expect(notificationTargetPath(undefined)).toBe("/");
  });
});

describe("parseSessionFromSearch", () => {
  test("reads the session parameter", () => {
    expect(parseSessionFromSearch("?session=s1")).toBe("s1");
    expect(parseSessionFromSearch("?foo=1&session=s2")).toBe("s2");
  });

  test("returns null when absent or empty", () => {
    expect(parseSessionFromSearch("")).toBeNull();
    expect(parseSessionFromSearch("?foo=1")).toBeNull();
    expect(parseSessionFromSearch("?session=")).toBeNull();
  });
});

describe("parseOpenSessionMessage", () => {
  test("extracts the session id from a valid message", () => {
    expect(parseOpenSessionMessage({ type: OPEN_SESSION_MESSAGE, sessionId: "s1" })).toBe("s1");
  });

  test("rejects unrelated or malformed messages", () => {
    expect(parseOpenSessionMessage({ type: "other", sessionId: "s1" })).toBeNull();
    expect(parseOpenSessionMessage({ type: OPEN_SESSION_MESSAGE })).toBeNull();
    expect(parseOpenSessionMessage(null)).toBeNull();
    expect(parseOpenSessionMessage("nope")).toBeNull();
  });
});
