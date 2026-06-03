import { describe, expect, test } from "bun:test";
import { selfSpawnArgs } from "../src/self-spawn.js";

describe("selfSpawnArgs", () => {
  test("source mode keeps the script path (argv[1]) before the extra args", () => {
    expect(selfSpawnArgs(["__session", "id1"], "/repo/src/index.ts")).toEqual([
      "/repo/src/index.ts",
      "__session",
      "id1"
    ]);
  });

  test("compiled mode (bunfs argv[1]) omits the script path", () => {
    expect(selfSpawnArgs(["__session", "id1"], "/$bunfs/root/climon")).toEqual([
      "__session",
      "id1"
    ]);
  });

  test("compiled mode omits user command argv[1]", () => {
    expect(selfSpawnArgs(["__session", "id1"], "powershell")).toEqual([
      "__session",
      "id1"
    ]);
  });

  test("missing argv[1] behaves like compiled mode (no leading undefined)", () => {
    expect(selfSpawnArgs(["__uplink"], undefined)).toEqual(["__uplink"]);
  });
});
