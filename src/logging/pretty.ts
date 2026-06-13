import { Writable } from "node:stream";
import { prettyFactory } from "pino-pretty";

let terminalSuspended = false;

/** Mutes (true) or restores (false) all pretty terminal output. */
export function setTerminalSuspended(value: boolean): void {
  terminalSuspended = value;
}

export function isTerminalSuspended(): boolean {
  return terminalSuspended;
}

export interface PrettyStreamOptions {
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  colorize?: boolean;
}

/**
 * Builds a Writable that pino-multistream feeds NDJSON lines into. Each line is
 * pretty-printed and routed by level: info/warn -> out, error/fatal -> err.
 * Output is suppressed while the terminal is suspended (client PTY attach).
 */
export function createPrettyStream(options: PrettyStreamOptions = {}): NodeJS.WritableStream {
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;
  const colorize = options.colorize ?? true;

  const prettyFormat = prettyFactory({ colorize });

  return new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      if (terminalSuspended) {
        cb();
        return;
      }
      const line = chunk.toString();
      let level = 30;
      try {
        level = JSON.parse(line).level ?? 30;
      } catch {
        // non-JSON line: default to info routing
      }
      const target = level >= 50 ? err : out;
      const formatted = prettyFormat(line);
      target.write(formatted);
      cb();
    },
  });
}
