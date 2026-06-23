export interface ParsedFileRef {
  path: string;
  line?: number;
  col?: number;
}

export interface FileTokenMatch {
  startIndex: number;
  length: number;
  ref: ParsedFileRef;
}

// A path-ish token: a run of path-safe chars, optionally followed by :line or
// :line:col. Deliberately conservative — a token is only a candidate; the server
// enforces all real confinement. The scan deliberately matches a single linear
// run (no ambiguous "[c]*[/.][c]+" shape) to avoid O(n^2) backtracking on long
// word-runs in attacker-influenceable terminal lines; parseFileToken then rejects
// candidates lacking a path separator or extension dot.
const TOKEN = /[A-Za-z0-9._\-~/]+(?::\d+(?::\d+)?)?/g;

/** Parses a single token into a ParsedFileRef, or null if it is not path-like. */
export function parseFileToken(token: string): ParsedFileRef | null {
  const match = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(token);
  if (!match) return null;
  const path = match[1];
  // Require a path separator or an extension dot so bare words/numbers are ignored.
  if (!/[/]/.test(path) && !/\.[A-Za-z0-9]+$/.test(path)) return null;
  const ref: ParsedFileRef = { path };
  if (match[2]) ref.line = Number(match[2]);
  if (match[3]) ref.col = Number(match[3]);
  return ref;
}

/** Finds all path-like tokens in a single line of terminal text. */
export function findFileTokens(lineText: string): FileTokenMatch[] {
  const out: FileTokenMatch[] = [];
  for (const m of lineText.matchAll(TOKEN)) {
    const token = m[0];
    const ref = parseFileToken(token);
    if (ref && m.index !== undefined) {
      out.push({ startIndex: m.index, length: token.length, ref });
    }
  }
  return out;
}
