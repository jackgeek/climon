export type ParsedCommand =
  | { command: "help" }
  | { command: "server"; lan: boolean; port?: number }
  | { command: "session"; id: string }
  | { command: "attach"; id: string }
  | { command: "ls" }
  | { command: "kill"; id: string }
  | { command: "run"; argv: string[]; headless: boolean };

export const helpText = `climon — web-based monitor for interactive CLI sessions

Usage:
  climon <command> [args...]   Run a command in a monitored PTY session
  climon server [--lan] [--port N]
                               Start the dashboard web server
  climon ls                    List monitored sessions
  climon attach <id>           Reattach to a running session
  climon kill <id>             Terminate a session
  climon help                  Show this help

While attached, detach without stopping the command using: Ctrl-\\ then d
`;

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
    case "server": {
      let lan = false;
      let port: number | undefined;
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i];
        if (arg === "--lan") {
          lan = true;
        } else if (arg === "--port") {
          port = Number(rest[i + 1]);
          i += 1;
        } else if (arg.startsWith("--port=")) {
          port = Number(arg.slice("--port=".length));
        }
      }
      return { command: "server", lan, port };
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
      if (!id) {
        throw new Error("Provide a session id, e.g. `climon kill <id>`.");
      }
      return { command: "kill", id };
    }
    case "run": {
      let headless = false;
      const runArgv: string[] = [];
      for (const arg of rest) {
        if (arg === "--headless" && runArgv.length === 0) {
          headless = true;
        } else {
          runArgv.push(arg);
        }
      }
      if (runArgv.length === 0) {
        throw new Error("Provide a command to run, e.g. `climon run npm test`.");
      }
      return { command: "run", argv: runArgv, headless };
    }
    default:
      return { command: "run", argv, headless: false };
  }
}
