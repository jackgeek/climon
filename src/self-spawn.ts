/**
 * Builds the arguments for re-spawning the climon executable (e.g. to start a
 * detached `__session` daemon).
 *
 * In a compiled Bun binary, `process.argv[1]` is a virtual `/$bunfs/...` path
 * that the binary re-injects on its own. Passing it through to a re-spawn shifts
 * the real arguments by one, so the child never matches its subcommand and forks
 * itself indefinitely. In source mode, `argv[1]` is the real script path and
 * must be passed so `bun` runs the right entrypoint.
 */
export function selfSpawnArgs(extra: string[], argv1?: string): string[] {
  const executableArgv1 = arguments.length < 2 ? process.argv[1] : argv1;
  const compiled = !executableArgv1 || executableArgv1.includes("$bunfs");
  return compiled ? [...extra] : [executableArgv1, ...extra];
}
