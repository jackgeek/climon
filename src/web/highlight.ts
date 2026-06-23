import hljs from "highlight.js/lib/common";

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  xml: "xml",
  html: "xml",
  htm: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  diff: "diff",
  patch: "diff",
  ini: "ini",
  dockerfile: "dockerfile",
  make: "makefile",
  mk: "makefile"
};

const BASENAME_TO_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  "cargo.toml": "toml",
  "cargo.lock": "toml"
};

/** Resolve an hljs language id for a filename, or undefined if unknown. */
export function languageForFilename(filename: string): string | undefined {
  const base = (filename.split(/[\\/]/).pop() ?? filename).toLowerCase();
  if (BASENAME_TO_LANG[base]) return BASENAME_TO_LANG[base];
  const dot = base.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = base.slice(dot + 1);
  return EXT_TO_LANG[ext];
}

/**
 * Split highlight.js HTML output into per-line strings, re-opening any spans
 * that were open at a line break so each line is independently well-formed.
 * This preserves multi-line grammar (e.g. block comments) while letting the
 * caller wrap each line in its own numbered row.
 */
function splitHighlightedHtml(html: string): string[] {
  const lines: string[] = [];
  const openStack: string[] = []; // full opening tags, e.g. '<span class="hljs-comment">'
  let current = "";
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === "<") {
      const end = html.indexOf(">", i);
      const tag = html.slice(i, end + 1);
      if (/^<span\b/i.test(tag)) {
        openStack.push(tag);
        current += tag;
      } else if (/^<\/span>/i.test(tag)) {
        openStack.pop();
        current += tag;
      } else {
        current += tag; // shouldn't happen in hljs output; pass through
      }
      i = end + 1;
      continue;
    }
    if (ch === "\n") {
      for (let k = 0; k < openStack.length; k++) current += "</span>";
      lines.push(current);
      current = openStack.join("");
      i += 1;
      continue;
    }
    let j = i;
    while (j < html.length && html[j] !== "<" && html[j] !== "\n") j++;
    current += html.slice(i, j);
    i = j;
  }
  for (let k = 0; k < openStack.length; k++) current += "</span>";
  lines.push(current);
  return lines;
}

function escapeHtmlForHighlight(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Highlight `content` and return per-line, HTML-escaped, span-wrapped strings.
 * Highlighting failure (or unknown language) falls back to auto-detection, and
 * then to plain escaped lines, so the viewer never breaks on highlighting.
 */
export function highlightToLines(content: string, language: string | undefined): string[] {
  try {
    const result =
      language && hljs.getLanguage(language)
        ? hljs.highlight(content, { language, ignoreIllegals: true })
        : hljs.highlightAuto(content);
    return splitHighlightedHtml(result.value);
  } catch {
    return content.split("\n").map(escapeHtmlForHighlight);
  }
}
