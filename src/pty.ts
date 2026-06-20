/**
 * ⚠️ LEGACY TypeScript client — frozen. Fix the Rust client instead.
 *
 * The shipping `climon` *client* is the Rust workspace under `rust/` (crates
 * `climon-cli`, `climon-session`, `climon-pty`, `climon-store`, `climon-config`,
 * `climon-remote`, `climon-install`, `climon-update`, …). This module belongs to
 * the legacy Bun/TypeScript client, kept only for local development and the Bun
 * test suite. Do NOT add features or fix client bugs here — make all client
 * changes in the Rust crates. (The Bun dashboard *server* under `src/server*`
 * and `src/web/` is NOT legacy and is still maintained.)
 */
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

  let appliedCols = options.cols;
  let appliedRows = options.rows;

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
      const nextCols = Math.max(cols, 1);
      const nextRows = Math.max(rows, 1);
      if (nextCols === appliedCols && nextRows === appliedRows) {
        return;
      }
      appliedCols = nextCols;
      appliedRows = nextRows;
      try {
        terminal.resize(nextCols, nextRows);
        // `Bun.Terminal.resize` updates the kernel window size (TIOCSWINSZ) but,
        // at least on macOS, does not signal the terminal's foreground process
        // group the way the kernel normally does on a winsize change. Node-based
        // TUIs such as the Copilot CLI cache `process.stdout.columns/rows` and
        // only refresh them on SIGWINCH, so without the signal they keep drawing
        // at the previous size. Browser viewers that resized their grid then
        // render the stale-sized output onto a different grid, corrupting the
        // display, while the local terminal (matching the program's size) looks
        // fine.
        //
        // Signalling only the direct child is not enough: when the PTY runs a
        // shell (e.g. `climon` wrapping zsh), the actual TUI is a *grandchild*
        // in a different process group, so the shell never forwards the signal.
        // Deliver SIGWINCH to the direct child and every descendant so nested
        // programs re-read the new size.
        if (process.platform !== "win32") {
          try {
            proc.kill("SIGWINCH");
          } catch {
            // Child already exited; nothing to signal.
          }
          for (const pid of descendantPids(proc.pid)) {
            try {
              process.kill(pid, "SIGWINCH");
            } catch {
              // Descendant exited between listing and signalling; ignore.
            }
          }
        }
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
 * Returns the PIDs of every descendant process of `rootPid` (children,
 * grandchildren, ...). Used to deliver SIGWINCH to a nested foreground program
 * when the PTY runs a shell. Returns an empty array on failure or on Windows.
 */
function descendantPids(rootPid: number): number[] {
  if (process.platform === "win32") {
    return [];
  }
  let stdout = "";
  try {
    // `-A` (all processes) + bare `pid=`/`ppid=` headers are POSIX and work on
    // both macOS and Linux. Spawning `ps` per resize is acceptable: resizes are
    // de-duped against the applied size before this runs.
    const result = Bun.spawnSync(["ps", "-A", "-o", "pid=", "-o", "ppid="]);
    stdout = result.success ? result.stdout.toString() : "";
  } catch {
    return [];
  }
  const childrenByParent = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [pidStr, ppidStr] = trimmed.split(/\s+/);
    const pid = Number(pidStr);
    const ppid = Number(ppidStr);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
      continue;
    }
    const siblings = childrenByParent.get(ppid);
    if (siblings) {
      siblings.push(pid);
    } else {
      childrenByParent.set(ppid, [pid]);
    }
  }
  const descendants: number[] = [];
  const stack = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (stack.length > 0) {
    const current = stack.pop() as number;
    for (const child of childrenByParent.get(current) ?? []) {
      if (seen.has(child)) {
        continue;
      }
      seen.add(child);
      descendants.push(child);
      stack.push(child);
    }
  }
  return descendants;
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
