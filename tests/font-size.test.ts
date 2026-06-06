import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FONT_SIZE,
  FONT_SIZE_STORAGE_KEY,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  clampFontSize,
  readFontSize,
  writeFontSize
} from "../src/web/fontSize.js";

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

function captureConsoleWarnings(run: () => void): unknown[][] {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    run();
  } finally {
    console.warn = originalWarn;
  }

  return warnings;
}

describe("clampFontSize", () => {
  test("clamps below the minimum up to the minimum", () => {
    expect(clampFontSize(MIN_FONT_SIZE - 1)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(0)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(-100)).toBe(MIN_FONT_SIZE);
  });

  test("clamps above the maximum down to the maximum", () => {
    expect(clampFontSize(MAX_FONT_SIZE + 1)).toBe(MAX_FONT_SIZE);
    expect(clampFontSize(1000)).toBe(MAX_FONT_SIZE);
  });

  test("passes through values in range", () => {
    expect(clampFontSize(MIN_FONT_SIZE)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(MAX_FONT_SIZE)).toBe(MAX_FONT_SIZE);
    expect(clampFontSize(13)).toBe(13);
  });

  test("maps non-finite values to the default", () => {
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_FONT_SIZE);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_FONT_SIZE);
    expect(clampFontSize(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_FONT_SIZE);
  });
});

describe("font size persistence", () => {
  test("defaults when storage is empty or unavailable", () => {
    expect(readFontSize(new MemoryStorage())).toBe(DEFAULT_FONT_SIZE);
    expect(readFontSize(null)).toBe(DEFAULT_FONT_SIZE);
    expect(readFontSize(undefined)).toBe(DEFAULT_FONT_SIZE);
  });

  test("returns the clamped stored value", () => {
    const storage = new MemoryStorage();
    storage.setItem(FONT_SIZE_STORAGE_KEY, "20");
    expect(readFontSize(storage)).toBe(20);

    storage.setItem(FONT_SIZE_STORAGE_KEY, "100");
    expect(readFontSize(storage)).toBe(MAX_FONT_SIZE);

    storage.setItem(FONT_SIZE_STORAGE_KEY, "1");
    expect(readFontSize(storage)).toBe(MIN_FONT_SIZE);
  });

  test("defaults when the stored value is unparseable", () => {
    const storage = new MemoryStorage();
    storage.setItem(FONT_SIZE_STORAGE_KEY, "not-a-number");
    expect(readFontSize(storage)).toBe(DEFAULT_FONT_SIZE);
  });

  test("writes the clamped size as a string", () => {
    const storage = new MemoryStorage();
    writeFontSize(20, storage);
    expect(storage.getItem(FONT_SIZE_STORAGE_KEY)).toBe("20");

    writeFontSize(100, storage);
    expect(storage.getItem(FONT_SIZE_STORAGE_KEY)).toBe(String(MAX_FONT_SIZE));

    writeFontSize(1, storage);
    expect(storage.getItem(FONT_SIZE_STORAGE_KEY)).toBe(String(MIN_FONT_SIZE));
  });

  test("storage failures do not throw", () => {
    const storage = new ThrowingStorage();
    const warnings = captureConsoleWarnings(() => {
      expect(() => readFontSize(storage)).not.toThrow();
      expect(() => writeFontSize(20, storage)).not.toThrow();
      expect(readFontSize(storage)).toBe(DEFAULT_FONT_SIZE);
    });

    expect(warnings).toHaveLength(3);
    expect(warnings[0]?.[0]).toBe("Unable to read font size preference.");
    expect(warnings[1]?.[0]).toBe("Unable to write font size preference.");
    expect(warnings[2]?.[0]).toBe("Unable to read font size preference.");
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
      expect(readFontSize(undefined, throwingReadResolver)).toBe(DEFAULT_FONT_SIZE);
      expect(() => writeFontSize(20, undefined, throwingWriteResolver)).not.toThrow();
    });

    expect(readLookups).toBe(1);
    expect(writeLookups).toBe(1);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.[0]).toBe("Unable to read font size preference.");
    expect(warnings[1]?.[0]).toBe("Unable to write font size preference.");
  });
});
