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

/**
 * The closed set of climon subcommand names. `logCliCommand` records only which
 * of these was invoked — never the user-supplied command that a session runs.
 * Mirrors the canonical Rust `command_name` set and `CLIMON_SUBCOMMANDS` in
 * `rust/climon-logging/src/cli_io.rs`; keep the two in sync.
 */
export const CLIMON_SUBCOMMANDS = [
  "help",
  "version",
  "server",
  "shell",
  "ls",
  "kill",
  "kill-all",
  "run",
  "spawn",
  "config",
  "cleanup",
  "remotes",
  "link",
  "uplink",
  "session",
  "update",
  "setup",
  "update-check",
  "ingest",
  "license",
] as const;

/** A climon subcommand name — never a user-supplied command line. */
export type ClimonSubcommand = (typeof CLIMON_SUBCOMMANDS)[number];

/**
 * Records which climon subcommand was invoked at debug level.
 *
 * Only the fixed subcommand keyword is logged (e.g. `run`, `server`); the
 * user-supplied command a session executes is deliberately never recorded here.
 * The parameter type is constrained to {@link ClimonSubcommand} so a full
 * command line can never be passed in by mistake.
 */
export function logCliCommand(subcommand: ClimonSubcommand): void {
  logMsg(child("cli"), "debug", "cli.command_invocation", { subcommand });
}
