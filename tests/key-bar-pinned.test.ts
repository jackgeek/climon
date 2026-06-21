import { describe, expect, test } from "bun:test";
import {
  KEY_BAR_PINNED_STORAGE_KEY,
  readKeyBarPinned,
  writeKeyBarPinned
} from "../src/web/keyBarPinned.js";

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

function captureConsoleWarnings(run: () => void): string[] {
  const originalWarn = console.warn;
  const messages: string[] = [];
  console.warn = (...args: unknown[]) => {
    const message = args.find((arg): arg is string => typeof arg === "string");
    if (message !== undefined) messages.push(message);
  };
  try {
    run();
  } finally {
    console.warn = originalWarn;
  }
  return messages;
}

describe("key bar pinned persistence", () => {
  test("defaults to unpinned when storage is empty or unavailable", () => {
    expect(readKeyBarPinned(new MemoryStorage())).toBe(false);
    expect(readKeyBarPinned(null)).toBe(false);
    expect(readKeyBarPinned(undefined)).toBe(false);
  });

  test("reads true only from the string true", () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_BAR_PINNED_STORAGE_KEY, "true");
    expect(readKeyBarPinned(storage)).toBe(true);

    storage.setItem(KEY_BAR_PINNED_STORAGE_KEY, "false");
    expect(readKeyBarPinned(storage)).toBe(false);

    storage.setItem(KEY_BAR_PINNED_STORAGE_KEY, "yes");
    expect(readKeyBarPinned(storage)).toBe(false);
  });

  test("writes the pinned preference as a string", () => {
    const storage = new MemoryStorage();
    writeKeyBarPinned(true, storage);
    expect(storage.getItem(KEY_BAR_PINNED_STORAGE_KEY)).toBe("true");

    writeKeyBarPinned(false, storage);
    expect(storage.getItem(KEY_BAR_PINNED_STORAGE_KEY)).toBe("false");
  });

  test("storage failures do not throw", () => {
    const storage = new ThrowingStorage();
    const warnings = captureConsoleWarnings(() => {
      expect(() => readKeyBarPinned(storage)).not.toThrow();
      expect(() => writeKeyBarPinned(true, storage)).not.toThrow();
      expect(readKeyBarPinned(storage)).toBe(false);
    });

    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toBe("Unable to read key bar pinned preference.");
    expect(warnings[1]).toBe("Unable to write key bar pinned preference.");
    expect(warnings[2]).toBe("Unable to read key bar pinned preference.");
  });
});
