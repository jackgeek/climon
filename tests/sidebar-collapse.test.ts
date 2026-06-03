import { describe, expect, test } from "bun:test";
import {
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  readSidebarCollapsed,
  writeSidebarCollapsed
} from "../src/web/sidebarCollapse.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class ThrowingStorage {
  getItem(_key: string): string | null {
    throw new Error("read failed");
  }

  setItem(_key: string, _value: string): void {
    throw new Error("write failed");
  }
}

describe("sidebar collapse persistence", () => {
  test("defaults to expanded when storage is empty or unavailable", () => {
    expect(readSidebarCollapsed(new MemoryStorage())).toBe(false);
    expect(readSidebarCollapsed(null)).toBe(false);
    expect(readSidebarCollapsed(undefined)).toBe(false);
  });

  test("reads true only from the string true", () => {
    const storage = new MemoryStorage();
    storage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "true");
    expect(readSidebarCollapsed(storage)).toBe(true);

    storage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "false");
    expect(readSidebarCollapsed(storage)).toBe(false);

    storage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "yes");
    expect(readSidebarCollapsed(storage)).toBe(false);
  });

  test("writes the collapsed preference as a string", () => {
    const storage = new MemoryStorage();
    writeSidebarCollapsed(true, storage);
    expect(storage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("true");

    writeSidebarCollapsed(false, storage);
    expect(storage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("false");
  });

  test("storage failures do not throw", () => {
    const storage = new ThrowingStorage();
    expect(() => readSidebarCollapsed(storage)).not.toThrow();
    expect(() => writeSidebarCollapsed(true, storage)).not.toThrow();
    expect(readSidebarCollapsed(storage)).toBe(false);
  });
});
