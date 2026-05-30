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

  test("parses server with port", () => {
    expect(parseArgs(["server", "--port", "9000"])).toEqual({
      command: "server",
      port: 9000
    });
  });

  test("parses server with --port= form", () => {
    expect(parseArgs(["server", "--port=4000"])).toEqual({
      command: "server",
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
    expect(parseArgs(["copilot", "--foo"])).toEqual({
      command: "run",
      argv: ["copilot", "--foo"],
      headless: false
    });
  });

  test("parses explicit run with --headless", () => {
    expect(parseArgs(["run", "--headless", "npm", "test"])).toEqual({
      command: "run",
      argv: ["npm", "test"],
      headless: true
    });
  });

  test("parses explicit run without --headless", () => {
    expect(parseArgs(["run", "npm", "test"])).toEqual({
      command: "run",
      argv: ["npm", "test"],
      headless: false
    });
  });

  test("throws when run has no command", () => {
    expect(() => parseArgs(["run"])).toThrow();
    expect(() => parseArgs(["run", "--headless"])).toThrow();
  });

  test("throws when session id missing", () => {
    expect(() => parseArgs(["__session"])).toThrow();
    expect(() => parseArgs(["attach"])).toThrow();
    expect(() => parseArgs(["kill"])).toThrow();
  });

  test("parses config passthrough argv", () => {
    expect(parseArgs(["config", "--global", "remote.host", "h"])).toEqual({
      command: "config",
      argv: ["--global", "remote.host", "h"]
    });
  });

  test("parses internal uplink entrypoint", () => {
    expect(parseArgs(["__uplink"])).toEqual({ command: "uplink" });
  });

  test("parses ssh-accept with label", () => {
    expect(parseArgs(["--ssh-accept", "--label", "devbox-1"])).toEqual({
      command: "ssh-accept",
      label: "devbox-1"
    });
  });

  test("throws when ssh-accept label missing", () => {
    expect(() => parseArgs(["--ssh-accept"])).toThrow();
  });
});
