import { describe, expect, test } from "bun:test";
import { EMBEDDED_DEFINE_ARGS, compiledServerBuildArgs } from "../scripts/server-build.js";

describe("compiledServerBuildArgs", () => {
  test("returns the full bun build --compile argument list for a given outfile", () => {
    const outfile = "/tmp/climon-server";
    expect(compiledServerBuildArgs(outfile)).toEqual([
      "build",
      "src/server.ts",
      "--compile",
      ...EMBEDDED_DEFINE_ARGS,
      "--outfile",
      outfile,
    ]);
  });
});
