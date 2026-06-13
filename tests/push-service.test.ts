import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPushService } from "../src/server/push/service.js";
import type { SessionMeta } from "../src/types.js";

function session(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    id: "s1",
    name: "",
    command: ["bash"],
    displayCommand: "bash",
    status: "running",
    ...overrides,
  } as SessionMeta;
}

describe("push service", () => {
  test("exposes a VAPID public key", async () => {
    const home = mkdtempSync(join(tmpdir(), "climon-svc-"));
    const svc = await createPushService(home);
    expect(svc.getVapidPublicKey()).toBeTruthy();
  });

  test("notifyAttention sends to subscribers on a new attention transition", async () => {
    const home = mkdtempSync(join(tmpdir(), "climon-svc-"));
    const sent: unknown[] = [];
    const svc = await createPushService(home, {
      async sendNotification(_sub, payload) {
        sent.push(payload);
      },
    });
    await svc.subscribe({ endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } });
    await svc.notifyAttention([session({ id: "s1", status: "running" })]); // seed
    await svc.notifyAttention([session({ id: "s1", status: "needs-attention", attentionMatchedAt: "2026-06-13T15:49:17.341Z" })]);
    expect(sent).toHaveLength(1);
  });
});
