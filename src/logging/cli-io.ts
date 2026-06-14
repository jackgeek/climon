import { child } from "./logger.js";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/**
 * Normalizes a chunk of terminal output for logging: strips a single trailing
 * newline and ANSI color codes so the log file stays readable.
 */
function toLogMessage(text: string): string {
  return text.replace(/\r?\n$/, "").replace(ANSI_PATTERN, "");
}

function mirror(stream: "stdout" | "stderr", text: string): void {
  const msg = toLogMessage(text);
  if (msg.length > 0) child("cli").debug({ stream }, msg);
}

/**
 * Writes user-facing output to stdout AND mirrors it to the cli debug log so a
 * command's terminal output is always captured in the log files. Terminal
 * output is unchanged.
 */
export function writeStdout(text: string): void {
  process.stdout.write(text);
  mirror("stdout", text);
}

/** Like {@link writeStdout}, but for stderr. */
export function writeStderr(text: string): void {
  process.stderr.write(text);
  mirror("stderr", text);
}

/** Records a CLI command invocation at debug level. */
export function logCliCommand(command: string): void {
  child("cli").debug({ command }, `cli command: ${command}`);
}
