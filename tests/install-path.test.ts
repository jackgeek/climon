import { describe, expect, test } from "bun:test";
import {
  appendPathEntryIfMissing,
  normalizePathEntry,
  pathContainsEntry
} from "../src/install/path.js";

const expand = (value: string): string =>
  value.replace(/%LOCALAPPDATA%/gi, "C:\\Users\\Ada\\AppData\\Local");

describe("normalizePathEntry", () => {
  test("trims whitespace, quotes, and trailing slashes", () => {
    expect(normalizePathEntry('  "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon\\\\"  ', expand))
      .toBe("c:\\users\\ada\\appdata\\local\\programs\\climon");
  });

  test("expands Windows environment variable references before comparing", () => {
    expect(normalizePathEntry("%LOCALAPPDATA%\\Programs\\climon", expand))
      .toBe("c:\\users\\ada\\appdata\\local\\programs\\climon");
  });
});

describe("pathContainsEntry", () => {
  test("matches an existing install path case-insensitively", () => {
    const currentPath = "C:\\Windows\\System32;C:\\USERS\\ADA\\APPDATA\\LOCAL\\PROGRAMS\\CLIMON";

    expect(pathContainsEntry(
      currentPath,
      "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
      expand
    )).toBe(true);
  });

  test("matches an existing install path that uses LOCALAPPDATA", () => {
    const currentPath = "C:\\Windows\\System32;%LOCALAPPDATA%\\Programs\\climon";

    expect(pathContainsEntry(
      currentPath,
      "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
      expand
    )).toBe(true);
  });
});

describe("appendPathEntryIfMissing", () => {
  test("returns the original PATH when the install path is already present", () => {
    const currentPath = "C:\\Windows\\System32;%LOCALAPPDATA%\\Programs\\climon";

    expect(appendPathEntryIfMissing(
      currentPath,
      "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
      expand
    )).toBe(currentPath);
  });

  test("appends the install path when it is missing", () => {
    expect(appendPathEntryIfMissing(
      "C:\\Windows\\System32",
      "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
      expand
    )).toBe("C:\\Windows\\System32;C:\\Users\\Ada\\AppData\\Local\\Programs\\climon");
  });

  test("returns only the install path when the current user PATH is empty", () => {
    expect(appendPathEntryIfMissing(
      "",
      "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
      expand
    )).toBe("C:\\Users\\Ada\\AppData\\Local\\Programs\\climon");
  });
});
