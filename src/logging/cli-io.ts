import { child } from "./logger.js";
import { logMsg } from "../i18n/log-msg.js";

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
  if (msg.length > 0) logMsg(child("cli"), "debug", "cli.stream_output", { stream, detail: msg });
}

/**
 * Writes user-facing output to stdout AND mirrors it to the cli debug log so a
 * command's terminal output is always captured in the log files. Terminal
 * output is unchanged.
 */
/**
 * Writes user-facing output to stdout AND mirrors it to the cli debug log so a
 * command's terminal output is always captured in the log files. Terminal
 * output is unchanged. Pass `{ log: false }` to skip the debug mirror for
 * high-volume, low-signal output such as `--help` text.
 */
export function writeStdout(text: string, options: { log?: boolean } = {}): void {
  process.stdout.write(text);
  if (options.log !== false) mirror("stdout", text);
}

/** Like {@link writeStdout}, but for stderr. */
export function writeStderr(text: string, options: { log?: boolean } = {}): void {
  process.stderr.write(text);
  if (options.log !== false) mirror("stderr", text);
}

/** Records a CLI command invocation at debug level. */
export function logCliCommand(command: string): void {
  logMsg(child("cli"), "debug", "cli.command_invocation", { command });
}
