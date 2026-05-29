import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli/args.js";

describe("parseArgs", () => {
  test("defaults to help with no args", () => {
    expect(parseArgs([])).toEqual({ command: "help" });
  });

  test("parses help flags", () => {
    expect(parseArgs(["--help"])).toEqual({ command: "help" });
    expect(parseArgs(["-h"])).toEqual({ command: "help" });
  });

  test("parses server with lan and port", () => {
    expect(parseArgs(["server", "--lan", "--port", "9000"])).toEqual({
      command: "server",
      lan: true,
      port: 9000
    });
  });

  test("parses server with --port= form", () => {
    expect(parseArgs(["server", "--port=4000"])).toEqual({
      command: "server",
      lan: false,
      port: 4000
    });
  });

  test("parses internal session entrypoint", () => {
    expect(parseArgs(["__session", "abc"])).toEqual({ command: "session", id: "abc" });
  });

  test("parses attach and reconnect aliases", () => {
    expect(parseArgs(["attach", "abc"])).toEqual({ command: "attach", id: "abc" });
    expect(parseArgs(["reconnect", "xyz"])).toEqual({ command: "attach", id: "xyz" });
  });

  test("parses ls and kill", () => {
    expect(parseArgs(["ls"])).toEqual({ command: "ls" });
    expect(parseArgs(["kill", "abc"])).toEqual({ command: "kill", id: "abc" });
  });

  test("treats unknown commands as run", () => {
    expect(parseArgs(["copilot", "--foo"])).toEqual({ command: "run", argv: ["copilot", "--foo"] });
  });

  test("throws when session id missing", () => {
    expect(() => parseArgs(["__session"])).toThrow();
    expect(() => parseArgs(["attach"])).toThrow();
    expect(() => parseArgs(["kill"])).toThrow();
  });
});
