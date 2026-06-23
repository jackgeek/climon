import { marked } from "marked";
import { highlightToLines, languageForFilename } from "./highlight.js";

export interface RenderOptions {
  content: string;
  filename: string;
  line?: number;
}

const CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

export function isMarkdownFilename(filename: string): boolean {
  return /\.(md|markdown)$/i.test(filename);
}

/**
 * Defense-in-depth scrub of rendered markdown HTML. The primary XSS boundary is
 * the sandboxed iframe (no allow-scripts) + CSP; this removes the obvious script
 * vectors so a CSP gap is not immediately exploitable.
 */
function stripDangerous(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?(?:script|iframe|object|embed|link|meta|base)\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*javascript:[^\s>]+/gi, '$1="#"');
}

function renderText(content: string, filename: string, line?: number): string {
  const language = languageForFilename(filename);
  const lineHtml = highlightToLines(content, language);
  const rows = lineHtml.map((html, index) => {
    const n = index + 1;
    const active = line === n ? " line-active" : "";
    return (
      `<div class="line${active}" data-line="${n}">` +
      `<span class="ln">${n}</span><span class="lt">${html}</span>` +
      `</div>`
    );
  });
  return `<div class="code">${rows.join("")}</div>`;
}

function renderMarkdown(content: string): string {
  const raw = marked.parse(content, { async: false }) as string;
  return `<div class="markdown">${stripDangerous(raw)}</div>`;
}

const STYLE = `
  :root { color-scheme: dark; }
  body { margin: 0; font: 13px/1.5 ui-monospace, monospace; background: #1e1e1e; color: #d4d4d4; }
  .code .line { display: flex; white-space: pre; }
  .code .ln { width: 3.5em; text-align: right; padding-right: 1em; color: #6a737d; user-select: none; }
  .code .lt { flex: 1; }
  .code .line-active { background: #3a3d41; }
  .markdown { padding: 1em 1.25em; font-family: system-ui, sans-serif; }
  .markdown pre { background: #111; padding: .75em; overflow:auto; }
  .code .lt .hljs-comment, .code .lt .hljs-quote { color: #6a9955; }
  .code .lt .hljs-keyword, .code .lt .hljs-selector-tag, .code .lt .hljs-built_in { color: #569cd6; }
  .code .lt .hljs-string, .code .lt .hljs-attr, .code .lt .hljs-template-variable { color: #ce9178; }
  .code .lt .hljs-number, .code .lt .hljs-literal { color: #b5cea8; }
  .code .lt .hljs-title, .code .lt .hljs-section, .code .lt .hljs-function .hljs-title { color: #dcdcaa; }
  .code .lt .hljs-type, .code .lt .hljs-class .hljs-title { color: #4ec9b0; }
  .code .lt .hljs-meta, .code .lt .hljs-symbol, .code .lt .hljs-bullet { color: #c586c0; }
  .code .lt .hljs-variable, .code .lt .hljs-name, .code .lt .hljs-attribute { color: #9cdcfe; }
  .code .lt .hljs-deletion { color: #f48771; }
  .code .lt .hljs-addition { color: #b5cea8; }
  .code .lt .hljs-emphasis { font-style: italic; }
  .code .lt .hljs-strong { font-weight: bold; }
`;

/** Builds a complete, self-contained HTML document for the viewer iframe srcdoc. */
export function renderFileHtml(opts: RenderOptions): string {
  const body = isMarkdownFilename(opts.filename)
    ? renderMarkdown(opts.content)
    : renderText(opts.content, opts.filename, opts.line);
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<style>${STYLE}</style></head><body>${body}</body></html>`
  );
}
