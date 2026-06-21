import { afterEach, describe, expect, test } from "bun:test";
import {
  cacheKeyFor,
  readCachedPreference,
  writeCachedPreference,
  migrateLegacyKeyBarPinned
} from "../src/web/preferences.js";
import { PREF_KEY_BAR_PINNED } from "../src/dashboard-preference-keys.js";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("preference cache", () => {
  test("round-trips a cached value as JSON", () => {
    const storage = new MemoryStorage();
    writeCachedPreference(PREF_KEY_BAR_PINNED, true, storage);
    expect(readCachedPreference(PREF_KEY_BAR_PINNED, storage)).toBe(true);
    expect(storage.getItem(cacheKeyFor(PREF_KEY_BAR_PINNED))).toBe("true");
  });

  test("returns undefined for an unset cache", () => {
    expect(readCachedPreference(PREF_KEY_BAR_PINNED, new MemoryStorage())).toBeUndefined();
  });
});

describe("legacy keyBarPinned migration", () => {
  test("seeds config once from the legacy localStorage key and clears it", async () => {
    const storage = new MemoryStorage();
    storage.setItem("climon.keyBarPinned", "true");
    const writes: Array<{ key: string; value: unknown }> = [];
    await migrateLegacyKeyBarPinned(storage, async (key, value) => {
      writes.push({ key, value });
    });
    expect(writes).toEqual([{ key: PREF_KEY_BAR_PINNED, value: true }]);
    expect(storage.getItem("climon.keyBarPinned")).toBeNull();
    // Second run is a no-op.
    await migrateLegacyKeyBarPinned(storage, async () => {
      throw new Error("should not run twice");
    });
  });

  test("does nothing when there is no legacy value", async () => {
    const storage = new MemoryStorage();
    await migrateLegacyKeyBarPinned(storage, async () => {
      throw new Error("should not run");
    });
    expect(true).toBe(true);
  });
});

afterEach(() => {
  /* MemoryStorage instances are per-test; nothing global to reset. */
});
