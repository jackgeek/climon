import { describe, expect, test } from "bun:test";
import { renderFileHtml, isMarkdownFilename } from "../src/web/file-render.js";

describe("isMarkdownFilename", () => {
  test("detects markdown extensions", () => {
    expect(isMarkdownFilename("README.md")).toBe(true);
    expect(isMarkdownFilename("notes.markdown")).toBe(true);
    expect(isMarkdownFilename("index.ts")).toBe(false);
  });
});

describe("renderFileHtml", () => {
  test("includes a restrictive CSP and escapes plain text", () => {
    const html = renderFileHtml({ content: "<script>alert(1)</script>", filename: "a.txt" });
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("script-src 'none'");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("renders line numbers and highlights the target line", () => {
    const html = renderFileHtml({ content: "one\ntwo\nthree", filename: "a.txt", line: 2 });
    expect(html).toContain('data-line="2"');
    expect(html).toContain("line-active");
  });

  test("renders markdown but strips embedded scripts and handlers", () => {
    const md = "# Title\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n<img src=x onerror=alert(1)>";
    const html = renderFileHtml({ content: md, filename: "doc.md" });
    expect(html).toContain("<h1");
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html.toLowerCase()).not.toContain("javascript:");
    expect(html.toLowerCase()).not.toContain("onerror");
  });
});
