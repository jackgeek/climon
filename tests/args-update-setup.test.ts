import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli/args.js";

describe("update/setup parsing", () => {
  test("`update` parses to the update command", () => {
    expect(parseArgs(["update"])).toEqual({ command: "update", argv: [] });
  });

  test("`--update` also parses to the update command", () => {
    expect(parseArgs(["--update"])).toEqual({ command: "update", argv: [] });
  });

  test("`update --check` carries through its argv", () => {
    expect(parseArgs(["update", "--check"])).toEqual({
      command: "update",
      argv: ["--check"],
    });
  });

  test("`setup` carries through its argv", () => {
    expect(parseArgs(["setup", "--telemetry=on"])).toEqual({
      command: "setup",
      argv: ["--telemetry=on"],
    });
  });
});
