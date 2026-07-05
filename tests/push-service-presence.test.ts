import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPushService } from "../src/server/push/service.js";
import type { WebPushClient } from "../src/server/push/send.js";
import type { SessionMeta } from "../src/types.js";

function meta(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    label: id,
    status: "needs-attention",
    command: "bash",
    displayCommand: "bash",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as SessionMeta;
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "climon-push-svc-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("createPushService presence suppression", () => {
  test("does not send to endpoints reported foreground", async () => {
    const sent: string[] = [];
    const client: WebPushClient = {
      sendNotification: async (s) => {
        sent.push(s.endpoint);
      },
    };
    const service = await createPushService(home, client);
    await service.subscribe({ endpoint: "https://push/fg", keys: { p256dh: "p", auth: "a" } });
    await service.subscribe({ endpoint: "https://push/bg", keys: { p256dh: "p", auth: "a" } });

    await service.notifyAttention([meta("s1", { status: "running" })]); // seed

    service.recordPresence("https://push/fg", true);

    await service.notifyAttention([meta("s1")]);

    expect(sent).toEqual(["https://push/bg"]);
  });

  test("sends to an endpoint after it reports background", async () => {
    const sent: string[] = [];
    const client: WebPushClient = {
      sendNotification: async (s) => {
        sent.push(s.endpoint);
      },
    };
    const service = await createPushService(home, client);
    await service.subscribe({ endpoint: "https://push/fg", keys: { p256dh: "p", auth: "a" } });

    await service.notifyAttention([meta("s1", { status: "running" })]); // seed

    service.recordPresence("https://push/fg", true);
    service.recordPresence("https://push/fg", false);

    await service.notifyAttention([meta("s1")]);

    expect(sent).toEqual(["https://push/fg"]);
  });
});
