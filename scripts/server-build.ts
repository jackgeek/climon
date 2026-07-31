/**
 * `bun build` flags that activate the embedded-asset code path in
 * `src/server/assets.ts` (the `__CLIMON_EMBEDDED__` define). EVERY build that
 * ships a self-contained server — the compiled `climon-server` binary — must
 * pass these, otherwise the server falls back to an on-the-fly source build that
 * does not exist on an end user's machine and the dashboard assets 404.
 */
export const EMBEDDED_DEFINE_ARGS = [
  "--define",
  "__CLIMON_EMBEDDED__=true",
] as const;

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
