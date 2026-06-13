import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPushService, resolveVapidSubject } from "../src/server/push/service.js";
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

describe("resolveVapidSubject", () => {
  test("default is a valid https/mailto URL that is not localhost", () => {
    const subject = resolveVapidSubject({} as NodeJS.ProcessEnv);
    const url = new URL(subject);
    expect(["mailto:", "https:"]).toContain(url.protocol);
    // Apple rejects a localhost subject with BadJwtToken.
    expect(url.hostname).not.toBe("localhost");
  });

  test("honors a CLIMON_VAPID_SUBJECT override", () => {
    expect(resolveVapidSubject({ CLIMON_VAPID_SUBJECT: "https://example.org/contact" } as NodeJS.ProcessEnv))
      .toBe("https://example.org/contact");
  });

  test("falls back to the default when the override is blank", () => {
    expect(resolveVapidSubject({ CLIMON_VAPID_SUBJECT: "   " } as NodeJS.ProcessEnv))
      .toBe("mailto:climon@example.com");
  });
});
