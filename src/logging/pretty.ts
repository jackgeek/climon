import { Writable } from "node:stream";

let terminalSuspended = false;

/** Mutes (true) or restores (false) all pretty terminal output. */
export function setTerminalSuspended(value: boolean): void {
  terminalSuspended = value;
}

export function isTerminalSuspended(): boolean {
  return terminalSuspended;
}

const RESET = "\u001b[0m";

/** ANSI color for a pino numeric level (message is tinted by severity). */
function colorForLevel(level: number): string {
  if (level >= 60) return "\u001b[35m"; // fatal — magenta
  if (level >= 50) return "\u001b[31m"; // error — red
  if (level >= 40) return "\u001b[33m"; // warn — yellow
  if (level >= 30) return "\u001b[32m"; // info — green
  if (level >= 20) return "\u001b[34m"; // debug — blue
  return "\u001b[90m"; // trace — gray
}

export interface PrettyStreamOptions {
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  colorize?: boolean;
}

/**
 * Builds a Writable that pino-multistream feeds NDJSON lines into. Only the
 * log message is printed — no timestamp, level, or pid — colored by severity
 * and routed by level: info/warn -> out, error/fatal -> err. Output is
 * suppressed while the terminal is suspended (client PTY attach).
 */
export function createPrettyStream(options: PrettyStreamOptions = {}): NodeJS.WritableStream {
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;
  const colorize = options.colorize ?? true;

  return new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      if (terminalSuspended) {
        cb();
        return;
      }
      const line = chunk.toString();
      let level = 30;
      let message = "";
      try {
        const record = JSON.parse(line);
        level = record.level ?? 30;
        message = typeof record.msg === "string" ? record.msg : "";
      } catch {
        // non-JSON line: emit it verbatim under info routing.
        message = line.replace(/\r?\n$/, "");
      }
      const target = level >= 50 ? err : out;
      if (message.length > 0) {
        target.write(colorize ? `${colorForLevel(level)}${message}${RESET}\n` : `${message}\n`);
      }
      cb();
    },
  });
}
