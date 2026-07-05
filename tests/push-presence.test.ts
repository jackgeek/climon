import { describe, expect, test } from "bun:test";
import { createPresenceRegistry } from "../src/server/push/presence.js";

describe("createPresenceRegistry", () => {
  test("an unseen endpoint is not foreground", () => {
    const reg = createPresenceRegistry({ now: () => 0, ttlMs: 100 });
    expect(reg.isForeground("https://push/a")).toBe(false);
  });

  test("markForeground makes an endpoint foreground until the TTL expires", () => {
    let t = 1000;
    const reg = createPresenceRegistry({ now: () => t, ttlMs: 100 });
    reg.markForeground("https://push/a");
    expect(reg.isForeground("https://push/a")).toBe(true);
    t = 1099;
    expect(reg.isForeground("https://push/a")).toBe(true);
    t = 1100;
    expect(reg.isForeground("https://push/a")).toBe(false);
  });

  test("a fresh markForeground extends the expiry (heartbeat)", () => {
    let t = 0;
    const reg = createPresenceRegistry({ now: () => t, ttlMs: 100 });
    reg.markForeground("https://push/a");
    t = 90;
    reg.markForeground("https://push/a");
    t = 150;
    expect(reg.isForeground("https://push/a")).toBe(true);
    t = 191;
    expect(reg.isForeground("https://push/a")).toBe(false);
  });

  test("markBackground immediately clears foreground", () => {
    const reg = createPresenceRegistry({ now: () => 0, ttlMs: 100 });
    reg.markForeground("https://push/a");
    reg.markBackground("https://push/a");
    expect(reg.isForeground("https://push/a")).toBe(false);
  });

  test("endpoints are tracked independently", () => {
    const reg = createPresenceRegistry({ now: () => 0, ttlMs: 100 });
    reg.markForeground("https://push/a");
    expect(reg.isForeground("https://push/a")).toBe(true);
    expect(reg.isForeground("https://push/b")).toBe(false);
  });
});
