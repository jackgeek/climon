import { Buffer } from "node:buffer";

export interface PtyOptions {
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
}

export interface PtyHandle {
  readonly pid: number;
  onData(listener: (data: Buffer) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals | number): void;
}

let cachedSetsidPath: string | null | undefined;

/**
 * Returns the path to a `setsid` binary that supports the `-c` (set
 * controlling terminal) flag, or `null` when unavailable. The result is cached
 * for the lifetime of the process.
 */
function findSetsid(): string | null {
  if (cachedSetsidPath !== undefined) {
    return cachedSetsidPath;
  }
  if (process.platform === "win32") {
    cachedSetsidPath = null;
    return cachedSetsidPath;
  }
  cachedSetsidPath = Bun.which("setsid");
  return cachedSetsidPath;
}

/**
 * Builds the argv passed to `Bun.spawn`. `Bun.spawn` attaches the PTY to the
 * child's stdio but does not make it the child's *controlling* terminal, so
 * shells print "cannot set terminal process group" / "no job control in this
 * shell". Wrapping the command in `setsid -c` starts the child in a new session
 * and adopts the PTY as the controlling terminal, restoring job control.
 */
function buildSpawnArgv(command: string, args: string[]): string[] {
  const setsid = findSetsid();
  if (setsid) {
    return [setsid, "-c", command, ...args];
  }
  return [command, ...args];
}

/**
 * Spawns a command attached to a pseudo-terminal using Bun's native PTY
 * (`Bun.Terminal` + `Bun.spawn`). Early output and a fast exit are buffered so
 * listeners attached shortly after spawn never miss data.
 */
export function spawnPty(options: PtyOptions): PtyHandle {
  const env = { ...(options.env ?? process.env) } as Record<string, string>;
  env.TERM = env.TERM ?? "xterm-256color";

  let dataListener: ((data: Buffer) => void) | undefined;
  const pendingData: Buffer[] = [];

  const exitListeners: Array<(exitCode: number) => void> = [];
  let exitCode: number | undefined;

  const terminal = new Bun.Terminal({
    cols: options.cols,
    rows: options.rows,
    name: env.TERM,
    data: (_term, data) => {
      const chunk = Buffer.from(data);
      if (dataListener) {
        dataListener(chunk);
      } else {
        pendingData.push(chunk);
      }
    }
  });

  const proc = Bun.spawn(buildSpawnArgv(options.command, options.args), {
    cwd: options.cwd,
    env,
    terminal
  });

  void proc.exited.then(() => {
    const code = typeof proc.exitCode === "number" ? proc.exitCode : proc.signalCode ? 1 : 0;
    exitCode = code;
    try {
      terminal.close();
    } catch {
      // Already closed.
    }
    for (const listener of exitListeners) {
      listener(code);
    }
  });

  return {
    pid: proc.pid,
    onData: (listener) => {
      dataListener = listener;
      if (pendingData.length > 0) {
        const drained = pendingData.splice(0);
        for (const chunk of drained) {
          listener(chunk);
        }
      }
    },
    onExit: (listener) => {
      exitListeners.push(listener);
      if (exitCode !== undefined) {
        listener(exitCode);
      }
    },
    write: (data) => {
      try {
        terminal.write(data);
      } catch {
        // Terminal closed mid-write.
      }
    },
    resize: (cols, rows) => {
      try {
        terminal.resize(Math.max(cols, 1), Math.max(rows, 1));
      } catch {
        // Resizing can fail transiently while the child is exiting; ignore.
      }
    },
    kill: (signal) => {
      try {
        proc.kill(signal as number | NodeJS.Signals | undefined);
      } catch {
        // Already dead.
      }
    }
  };
}

/**
 * Splits a command array into the executable plus its arguments.
 */
export function resolveCommand(command: string[]): { file: string; args: string[] } {
  if (command.length === 0) {
    throw new Error("Cannot spawn an empty command.");
  }
  return { file: command[0], args: command.slice(1) };
}
