/**
 * Shared bun-build argument helpers for compiling the climon-server binary.
 *
 * Exported so both the release compile script and the server smoke test use
 * identical flags — preventing a silent desync between local testing and CI.
 */

/**
 * `bun build` flags that activate the embedded-asset code path via
 * `__CLIMON_EMBEDDED__=true`. Every compiled `climon-server` binary must
 * pass these; otherwise the server falls back to an on-the-fly source build
 * that doesn't exist on an end user's machine.
 */
export const EMBEDDED_DEFINE_ARGS = [
  "--define",
  "__CLIMON_EMBEDDED__=true",
] as const;

/**
 * Returns the full `bun build` argument list for a native-target
 * `--compile` server binary written to `outfile`.
 */
export function compiledServerBuildArgs(outfile: string): string[] {
  return [
    "build",
    "src/server.ts",
    "--compile",
    ...EMBEDDED_DEFINE_ARGS,
    "--outfile",
    outfile,
  ];
}
