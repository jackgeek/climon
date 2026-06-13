import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateVapidKeys } from "../src/server/push/vapid.js";

describe("vapid", () => {
  test("creates keys on first call and persists them", async () => {
    const home = mkdtempSync(join(tmpdir(), "climon-vapid-"));
    const first = await loadOrCreateVapidKeys(home);
    expect(first.publicKey).toBeTruthy();
    expect(first.privateKey).toBeTruthy();

    const second = await loadOrCreateVapidKeys(home);
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.privateKey).toBe(first.privateKey);
  });

  test("stores the keypair under push/vapid.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "climon-vapid-"));
    await loadOrCreateVapidKeys(home);
    const file = Bun.file(join(home, "push", "vapid.json"));
    expect(await file.exists()).toBe(true);
    const parsed = (await file.json()) as { publicKey: string; privateKey: string };
    expect(parsed.publicKey).toBeTruthy();
    expect(parsed.privateKey).toBeTruthy();
  });
});
