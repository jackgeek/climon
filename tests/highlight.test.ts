import { describe, expect, test } from "bun:test";
import { languageForFilename, highlightToLines } from "../src/web/highlight.js";

describe("languageForFilename", () => {
  test("maps common extensions to hljs language ids", () => {
    expect(languageForFilename("a.ts")).toBe("typescript");
    expect(languageForFilename("a.tsx")).toBe("typescript");
    expect(languageForFilename("a.js")).toBe("javascript");
    expect(languageForFilename("a.py")).toBe("python");
    expect(languageForFilename("main.rs")).toBe("rust");
    expect(languageForFilename("a.go")).toBe("go");
    expect(languageForFilename("a.json")).toBe("json");
    expect(languageForFilename("a.sh")).toBe("bash");
    expect(languageForFilename("a.css")).toBe("css");
  });

  test("special-cases known basenames", () => {
    expect(languageForFilename("Dockerfile")).toBe("dockerfile");
    expect(languageForFilename("Makefile")).toBe("makefile");
    expect(languageForFilename("Cargo.toml")).toBe("toml");
  });

  test("returns undefined for unknown extensions", () => {
    expect(languageForFilename("a.unknownext")).toBeUndefined();
    expect(languageForFilename("noext")).toBeUndefined();
  });
});

describe("highlightToLines", () => {
  test("returns one entry per source line", () => {
    const lines = highlightToLines("a\nb\nc", "javascript");
    expect(lines).toHaveLength(3);
  });

  test("escapes source so no live markup leaks", () => {
    const lines = highlightToLines('const x = "<b>";', "javascript");
    const html = lines.join("\n");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
  });

  test("keeps multi-line block comments highlighted across the split", () => {
    const src = "/* line one\nline two */\ncode";
    const lines = highlightToLines(src, "javascript");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("hljs-comment");
    expect(lines[1]).toContain("hljs-comment");
  });

  test("balances span tags within each line", () => {
    const src = "/* a\nb */\nx";
    for (const line of highlightToLines(src, "javascript")) {
      const opens = (line.match(/<span\b/g) ?? []).length;
      const closes = (line.match(/<\/span>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  test("falls back to plain escaped lines when language is undefined", () => {
    const lines = highlightToLines("def f():\n    return 1", undefined);
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("hljs-");
  });

  test("empty content yields a single empty line", () => {
    expect(highlightToLines("", "javascript")).toEqual([""]);
  });
});
