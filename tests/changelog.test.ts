import { describe, expect, test } from "bun:test";
import {
  formatChangelog,
  getChangesSince,
  type ChangelogEntry,
} from "../src/install/changelog.js";

const sampleChangelog: ChangelogEntry[] = [
  { version: "0.10.0", changes: ["Remote session resume", "Dashboard redesign"] },
  { version: "0.9.2", changes: ["Fixed scrollback corruption", "Improved PTY resize"] },
  { version: "0.9.1", changes: ["Initial release"] },
];

describe("getChangesSince", () => {
  test("returns all entries when fromVersion is undefined (fresh install)", () => {
    const result = getChangesSince(sampleChangelog, undefined);
    expect(result).toEqual(sampleChangelog);
  });

  test("returns entries newer than the given version", () => {
    const result = getChangesSince(sampleChangelog, "0.9.1");
    expect(result).toEqual([
      { version: "0.10.0", changes: ["Remote session resume", "Dashboard redesign"] },
      { version: "0.9.2", changes: ["Fixed scrollback corruption", "Improved PTY resize"] },
    ]);
  });

  test("returns only the latest entry when upgrading from second-newest", () => {
    const result = getChangesSince(sampleChangelog, "0.9.2");
    expect(result).toEqual([
      { version: "0.10.0", changes: ["Remote session resume", "Dashboard redesign"] },
    ]);
  });

  test("returns empty array when already on latest version", () => {
    const result = getChangesSince(sampleChangelog, "0.10.0");
    expect(result).toEqual([]);
  });

  test("returns empty array when fromVersion is newer than all entries", () => {
    const result = getChangesSince(sampleChangelog, "1.0.0");
    expect(result).toEqual([]);
  });
});

describe("formatChangelog", () => {
  test("returns empty string for no entries", () => {
    expect(formatChangelog([])).toBe("");
  });

  test("formats a single entry", () => {
    const result = formatChangelog([
      { version: "0.9.2", changes: ["Fixed scrollback corruption"] },
    ]);
    expect(result).toContain("What's new:");
    expect(result).toContain("v0.9.2:");
    expect(result).toContain("• Fixed scrollback corruption");
  });

  test("formats multiple entries with all changes", () => {
    const result = formatChangelog(sampleChangelog.slice(0, 2));
    expect(result).toContain("v0.10.0:");
    expect(result).toContain("• Remote session resume");
    expect(result).toContain("• Dashboard redesign");
    expect(result).toContain("v0.9.2:");
    expect(result).toContain("• Fixed scrollback corruption");
    expect(result).toContain("• Improved PTY resize");
  });
});
