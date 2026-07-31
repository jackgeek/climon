import { describe, expect, test } from "bun:test";
import {
  EMBEDDED_DEFINE_ARGS,
  compiledServerBuildArgs,
} from "../scripts/server-build.js";

describe("compiledServerBuildArgs", () => {
  test("builds the host compiled server args with embedded define flags", () => {
    expect(compiledServerBuildArgs("/tmp/climon-server")).toEqual([
      "build",
      "src/server.ts",
      "--compile",
      ...EMBEDDED_DEFINE_ARGS,
      "--outfile",
      "/tmp/climon-server",
    ]);
  });
});
