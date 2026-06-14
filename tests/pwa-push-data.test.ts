import { describe, expect, test } from "bun:test";
import {
  parsePushData,
  buildNotificationOptions,
  notificationTargetPath,
  parseSessionFromSearch,
  parseOpenSessionMessage,
  OPEN_SESSION_MESSAGE,
  VIEWED_SESSION_QUERY,
  viewedSessionResponse,
  parseViewedSessionResponse,
  isViewedSessionQuery,
  shouldSuppressPush,
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

describe("viewedSessionResponse", () => {
  test("wraps a session id", () => {
    expect(viewedSessionResponse("s1")).toEqual({ type: VIEWED_SESSION_QUERY, sessionId: "s1" });
  });

  test("normalizes empty/null to null", () => {
    expect(viewedSessionResponse(null)).toEqual({ type: VIEWED_SESSION_QUERY, sessionId: null });
    expect(viewedSessionResponse("")).toEqual({ type: VIEWED_SESSION_QUERY, sessionId: null });
  });
});

describe("parseViewedSessionResponse", () => {
  test("reads a viewed session id from a valid reply", () => {
    expect(parseViewedSessionResponse({ type: VIEWED_SESSION_QUERY, sessionId: "s1" })).toBe("s1");
  });

  test("returns null for a not-viewing reply or malformed input", () => {
    expect(parseViewedSessionResponse({ type: VIEWED_SESSION_QUERY, sessionId: null })).toBeNull();
    expect(parseViewedSessionResponse({ type: VIEWED_SESSION_QUERY })).toBeNull();
    expect(parseViewedSessionResponse({ type: "other", sessionId: "s1" })).toBeNull();
    expect(parseViewedSessionResponse(null)).toBeNull();
    expect(parseViewedSessionResponse("nope")).toBeNull();
  });
});

describe("isViewedSessionQuery", () => {
  test("accepts the query message and rejects others", () => {
    expect(isViewedSessionQuery({ type: VIEWED_SESSION_QUERY })).toBe(true);
    expect(isViewedSessionQuery({ type: "other" })).toBe(false);
    expect(isViewedSessionQuery(null)).toBe(false);
    expect(isViewedSessionQuery("nope")).toBe(false);
  });
});

describe("shouldSuppressPush", () => {
  test("suppresses when a client is viewing the pushed session", () => {
    expect(shouldSuppressPush("s1", ["s1"])).toBe(true);
    expect(shouldSuppressPush("s1", [null, "s2", "s1"])).toBe(true);
  });

  test("does not suppress when no client views the pushed session", () => {
    expect(shouldSuppressPush("s1", ["s2", null])).toBe(false);
    expect(shouldSuppressPush("s1", [])).toBe(false);
  });

  test("never suppresses a generic push with no session id", () => {
    expect(shouldSuppressPush(undefined, ["s1"])).toBe(false);
  });
});
