import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSubscription, listSubscriptions } from "../src/server/push/subscriptions.js";
import { sendPushToAll, type WebPushClient } from "../src/server/push/send.js";

function sub(endpoint: string) {
  return { endpoint, keys: { p256dh: "p", auth: "a" } };
}

describe("sendPushToAll", () => {
  test("sends to every subscription", async () => {
    const home = mkdtempSync(join(tmpdir(), "climon-send-"));
    await addSubscription(home, sub("https://push.example/1"));
    await addSubscription(home, sub("https://push.example/2"));
    const sent: string[] = [];
    const client: WebPushClient = {
      async sendNotification(s) {
        sent.push(s.endpoint);
      },
    };
    await sendPushToAll(home, client, { hello: "world" });
    expect(sent.sort()).toEqual(["https://push.example/1", "https://push.example/2"]);
  });

  test("prunes a subscription that returns 410", async () => {
    const home = mkdtempSync(join(tmpdir(), "climon-send-"));
    await addSubscription(home, sub("https://push.example/gone"));
    await addSubscription(home, sub("https://push.example/ok"));
    const client: WebPushClient = {
      async sendNotification(s) {
        if (s.endpoint.endsWith("gone")) {
          throw Object.assign(new Error("gone"), { statusCode: 410 });
        }
      },
    };
    await sendPushToAll(home, client, { x: 1 });
    const remaining = (await listSubscriptions(home)).map((s) => s.endpoint);
    expect(remaining).toEqual(["https://push.example/ok"]);
  });

  test("keeps a subscription on a non-gone error", async () => {
    const home = mkdtempSync(join(tmpdir(), "climon-send-"));
    await addSubscription(home, sub("https://push.example/flaky"));
    const client: WebPushClient = {
      async sendNotification() {
        throw Object.assign(new Error("boom"), { statusCode: 500 });
      },
    };
    await sendPushToAll(home, client, { x: 1 });
    expect((await listSubscriptions(home)).map((s) => s.endpoint)).toEqual(["https://push.example/flaky"]);
  });
});
