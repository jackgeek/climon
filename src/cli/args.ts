import { VERSION } from "../version.js";
import { parseColorMode, parsePriority } from "../session-meta.js";
import type { SessionColorMode } from "../types.js";

export type ParsedCommand =
  | { command: "help" }
  | { command: "version" }
  | { command: "server"; port?: number; enableRemotes?: boolean }
  | { command: "session"; id: string }
  | { command: "attach"; id: string }
  | { command: "ls" }
  | { command: "kill"; id: string }
  | { command: "kill-all" }
  | { command: "run"; argv: string[]; headless: boolean; priority?: number; color?: SessionColorMode | null; name?: string }
  | { command: "config"; argv: string[] }
  | { command: "link"; argv: string[] }
  | { command: "uplink" }
  | { command: "ingest" };

export const helpText = `climon v${VERSION} — web-based monitor for interactive CLI sessions

Usage:
  climon [--priority N] [--color C] [--name S] <command> [args...]
                               Run a command in a monitored PTY session
                               (priority 0-1000; color: auto|none|black|red|
                               green|yellow|blue|magenta|cyan|white)
  climon server [--port N] [--enable-remotes]
                               Start the dashboard web server (loopback only)
  climon ls                    List monitored sessions
  climon config <key> [value]   Get/set configuration (git-style)
  climon config --help          Show config settings, defaults, and scopes
  climon config --debug         Show config files, keys, and values (redacted) in resolution order
  climon config --purge         Prompt to delete config files in resolution order
  climon link [--peer-home P]   Link WSL<->Windows dashboard discovery
  climon attach <id>           Reattach to a running session
  climon kill <id>             Terminate a session
  climon kill --all            Kill or remove all active sessions
  climon --version             Show the climon version
  climon help                  Show this help

While attached, detach without stopping the command using: Ctrl-\\ then d
`;

interface SessionFlags {
  priority?: number;
  color?: SessionColorMode | null;
  name?: string;
}

/**
 * Consumes leading --priority/--color/--name flags (both `--flag value` and
 * `--flag=value` forms) from the front of `tokens`, stopping at the first token
 * that is not one of those flags. Returns the parsed flags plus the remaining
 * tokens (the monitored command and its arguments). Throws on invalid values.
 */
function parseSessionFlags(tokens: string[]): { flags: SessionFlags; rest: string[] } {
  const flags: SessionFlags = {};
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const eq = token.indexOf("=");
    const key = token.startsWith("--") && eq !== -1 ? token.slice(0, eq) : token;
    const inlineValue = token.startsWith("--") && eq !== -1 ? token.slice(eq + 1) : undefined;
    const takeValue = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const next = tokens[i + 1];
      if (next === undefined) {
        throw new Error(`Missing value for ${key}.`);
      }
      i += 1;
      return next;
    };
    if (key === "--priority") {
      flags.priority = parsePriority(takeValue());
    } else if (key === "--color") {
      const mode = parseColorMode(takeValue());
      flags.color = mode === "none" ? null : mode;
    } else if (key === "--name") {
      flags.name = takeValue();
    } else {
      break;
    }
    i += 1;
  }
  return { flags, rest: tokens.slice(i) };
}

export function parseArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0) {
    return { command: "help" };
  }

  const [first, ...rest] = argv;

  switch (first) {
    case "help":
    case "--help":
    case "-h":
      return { command: "help" };
    case "--version":
    case "-v":
      return { command: "version" };
    case "server": {
      let port: number | undefined;
      let enableRemotes = false;
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i];
        if (arg === "--port") {
          port = Number(rest[i + 1]);
          i += 1;
        } else if (arg.startsWith("--port=")) {
          port = Number(arg.slice("--port=".length));
        } else if (arg === "--enable-remotes") {
          enableRemotes = true;
        }
      }
      return { command: "server", port, ...(enableRemotes ? { enableRemotes } : {}) };
    }
    case "__session": {
      const id = rest[0];
      if (!id) {
        throw new Error("Internal: __session requires a session id.");
      }
      return { command: "session", id };
    }
    case "attach":
    case "reconnect": {
      const id = rest[0];
      if (!id) {
        throw new Error("Provide a session id, e.g. `climon attach <id>`.");
      }
      return { command: "attach", id };
    }
    case "ls":
    case "list":
      return { command: "ls" };
    case "kill": {
      const id = rest[0];
      if (id === "--all") {
        return { command: "kill-all" };
      }
      if (!id) {
        throw new Error("Provide a session id, e.g. `climon kill <id>`.");
      }
      return { command: "kill", id };
    }
    case "run": {
      let headless = false;
      const remaining: string[] = [];
      let sawNonHeadless = false;
      for (const arg of rest) {
        if (arg === "--headless" && !sawNonHeadless && remaining.length === 0) {
          headless = true;
        } else {
          sawNonHeadless = true;
          remaining.push(arg);
        }
      }
      const { flags, rest: runArgv } = parseSessionFlags(remaining);
      if (runArgv.length === 0) {
        throw new Error("Provide a command to run, e.g. `climon run npm test`.");
      }
      return { command: "run", argv: runArgv, headless, ...flags };
    }
    case "config":
      return { command: "config", argv: rest };
    case "link":
      return { command: "link", argv: rest };
    case "__uplink":
      return { command: "uplink" };
    case "__ingest":
      return { command: "ingest" };
    default: {
      const { flags, rest: runArgv } = parseSessionFlags(argv);
      if (runArgv.length === 0) {
        throw new Error("Provide a command to run, e.g. `climon npm test`.");
      }
      return { command: "run", argv: runArgv, headless: false, ...flags };
    }
  }
}
