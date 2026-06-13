import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSubscription,
  listSubscriptions,
  removeSubscription,
  type StoredPushSubscription,
} from "../src/server/push/subscriptions.js";

function sub(endpoint: string): StoredPushSubscription {
  return { endpoint, keys: { p256dh: "p", auth: "a" } };
}

describe("subscription store", () => {
  test("adds and lists subscriptions", async () => {
    const home = mkdtempSync(join(tmpdir(), "climon-subs-"));
    await addSubscription(home, sub("https://push.example/1"));
    const all = await listSubscriptions(home);
    expect(all).toHaveLength(1);
    expect(all[0]?.endpoint).toBe("https://push.example/1");
  });

  test("dedupes by endpoint", async () => {
    const home = mkdtempSync(join(tmpdir(), "climon-subs-"));
    await addSubscription(home, sub("https://push.example/1"));
    await addSubscription(home, { ...sub("https://push.example/1"), keys: { p256dh: "x", auth: "y" } });
    const all = await listSubscriptions(home);
    expect(all).toHaveLength(1);
    expect(all[0]?.keys.p256dh).toBe("x");
  });

  test("removes by endpoint", async () => {
    const home = mkdtempSync(join(tmpdir(), "climon-subs-"));
    await addSubscription(home, sub("https://push.example/1"));
    await addSubscription(home, sub("https://push.example/2"));
    await removeSubscription(home, "https://push.example/1");
    const all = await listSubscriptions(home);
    expect(all.map((s) => s.endpoint)).toEqual(["https://push.example/2"]);
  });

  test("returns empty list when no file exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "climon-subs-"));
    expect(await listSubscriptions(home)).toEqual([]);
  });
});
