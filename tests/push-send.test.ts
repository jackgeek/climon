import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendPushToAll, type WebPushClient } from "../src/server/push/send.js";
import { addSubscription, type StoredPushSubscription } from "../src/server/push/subscriptions.js";

function sub(endpoint: string): StoredPushSubscription {
  return { endpoint, keys: { p256dh: "p", auth: "a" } };
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "climon-push-send-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("sendPushToAll", () => {
  test("sends to every subscription when no skip predicate is given", async () => {
    await addSubscription(home, sub("https://push/a"));
    await addSubscription(home, sub("https://push/b"));
    const sent: string[] = [];
    const client: WebPushClient = {
      sendNotification: async (s) => {
        sent.push(s.endpoint);
      }
    };
    await sendPushToAll(home, client, { title: "t" });
    expect(sent.sort()).toEqual(["https://push/a", "https://push/b"]);
  });

  test("skips endpoints for which skip() returns true", async () => {
    await addSubscription(home, sub("https://push/a"));
    await addSubscription(home, sub("https://push/b"));
    const sent: string[] = [];
    const client: WebPushClient = {
      sendNotification: async (s) => {
        sent.push(s.endpoint);
      }
    };
    await sendPushToAll(home, client, { title: "t" }, (endpoint) => endpoint === "https://push/a");
    expect(sent).toEqual(["https://push/b"]);
  });
});
