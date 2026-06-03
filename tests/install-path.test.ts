import { describe, expect, test } from "bun:test";
import {
  ensurePathEntryFirst,
  normalizePathEntry,
  pathContainsEntry
} from "../src/install/path.js";
import { updateUserPathWithIO } from "../src/install/index.js";

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

describe("ensurePathEntryFirst", () => {
  test("returns the original PATH when the install path is already first", () => {
    const currentPath = "C:\\Windows\\System32;%LOCALAPPDATA%\\Programs\\climon";

    expect(ensurePathEntryFirst(
      currentPath,
      "C:\\Windows\\System32",
      expand
    )).toBe(currentPath);
  });

  test("prepends the install path when it is missing", () => {
    expect(ensurePathEntryFirst(
      "C:\\Windows\\System32",
      "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
      expand
    )).toBe("C:\\Users\\Ada\\AppData\\Local\\Programs\\climon;C:\\Windows\\System32");
  });

  test("moves an existing install path before earlier entries", () => {
    expect(ensurePathEntryFirst(
      "C:\\Windows\\System32;%LOCALAPPDATA%\\Programs\\climon",
      "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
      expand
    )).toBe("C:\\Users\\Ada\\AppData\\Local\\Programs\\climon;C:\\Windows\\System32");
  });

  test("moves an existing install path before a conflicting .local bin entry", () => {
    expect(ensurePathEntryFirst(
      "C:\\Users\\Ada\\.local\\bin;C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
      "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
      expand
    )).toBe("C:\\Users\\Ada\\AppData\\Local\\Programs\\climon;C:\\Users\\Ada\\.local\\bin");
  });

  test("removes duplicate equivalent install paths when moving it first", () => {
    expect(ensurePathEntryFirst(
      "C:\\Windows\\System32;%LOCALAPPDATA%\\Programs\\climon;C:\\USERS\\ADA\\APPDATA\\LOCAL\\PROGRAMS\\CLIMON",
      "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
      expand
    )).toBe("C:\\Users\\Ada\\AppData\\Local\\Programs\\climon;C:\\Windows\\System32");
  });

  test("returns only the install path when the current user PATH is empty", () => {
    expect(ensurePathEntryFirst(
      "",
      "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
      expand
    )).toBe("C:\\Users\\Ada\\AppData\\Local\\Programs\\climon");
  });
});

describe("updateUserPathWithIO", () => {
  test("rewrites PATH when climon already exists after a conflicting entry", () => {
    let writtenPath = "";
    let broadcastCount = 0;

    const changed = updateUserPathWithIO("C:\\Users\\Ada\\AppData\\Local\\Programs\\climon", {
      readUserPath: () => "C:\\Users\\Ada\\.local\\bin;C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
      writeUserPath: (value) => {
        writtenPath = value;
      },
      broadcastEnvironmentChange: () => {
        broadcastCount += 1;
      },
      expandEnvironmentString: expand
    });

    expect(changed).toBe(true);
    expect(writtenPath).toBe("C:\\Users\\Ada\\AppData\\Local\\Programs\\climon;C:\\Users\\Ada\\.local\\bin");
    expect(broadcastCount).toBe(1);
  });
});
