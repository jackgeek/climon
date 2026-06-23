import { marked } from "marked";

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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function renderText(content: string, line?: number): string {
  const rows = content.split("\n").map((text, index) => {
    const n = index + 1;
    const active = line === n ? " line-active" : "";
    return (
      `<div class="line${active}" data-line="${n}">` +
      `<span class="ln">${n}</span><span class="lt">${escapeHtml(text)}</span>` +
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
`;

/** Builds a complete, self-contained HTML document for the viewer iframe srcdoc. */
export function renderFileHtml(opts: RenderOptions): string {
  const body = isMarkdownFilename(opts.filename)
    ? renderMarkdown(opts.content)
    : renderText(opts.content, opts.line);
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<style>${STYLE}</style></head><body>${body}</body></html>`
  );
}
