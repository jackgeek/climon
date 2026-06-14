import { describe, expect, test } from "bun:test";
import {
  effectiveSidebarCollapsed,
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
    const warnings = captureConsoleWarnings(() => {
      expect(() => readSidebarCollapsed(storage)).not.toThrow();
      expect(() => writeSidebarCollapsed(true, storage)).not.toThrow();
      expect(readSidebarCollapsed(storage)).toBe(false);
    });

    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toBe("Unable to read sidebar collapse preference.");
    expect(warnings[1]).toBe("Unable to write sidebar collapse preference.");
    expect(warnings[2]).toBe("Unable to read sidebar collapse preference.");
  });

  test("falls back and warns when implicit browser storage lookup throws", () => {
    let readLookups = 0;
    const throwingReadResolver = () => {
      readLookups += 1;
      throw new Error("localStorage unavailable");
    };

    let writeLookups = 0;
    const throwingWriteResolver = () => {
      writeLookups += 1;
      throw new Error("localStorage unavailable");
    };

    const warnings = captureConsoleWarnings(() => {
      expect(readSidebarCollapsed(undefined, throwingReadResolver)).toBe(false);
      expect(() => writeSidebarCollapsed(true, undefined, throwingWriteResolver)).not.toThrow();
    });

    expect(readLookups).toBe(1);
    expect(writeLookups).toBe(1);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toBe("Unable to read sidebar collapse preference.");
    expect(warnings[1]).toBe("Unable to write sidebar collapse preference.");
  });
});

describe("effectiveSidebarCollapsed", () => {
  test("honors the persisted collapsed preference on desktop", () => {
    expect(effectiveSidebarCollapsed(true, false)).toBe(true);
    expect(effectiveSidebarCollapsed(false, false)).toBe(false);
  });

  test("forces expanded mode on mobile without changing the persisted preference", () => {
    expect(effectiveSidebarCollapsed(true, true)).toBe(false);
    expect(effectiveSidebarCollapsed(false, true)).toBe(false);
  });
});
