import { describe, expect, test } from "bun:test";
import { parseArgs, helpText } from "../src/cli/args.js";
import { VERSION } from "../src/version.js";

describe("helpText", () => {
  test("includes the climon version", () => {
    expect(helpText).toContain(`v${VERSION}`);
  });

  test("documents bulk kill", () => {
    expect(helpText).toContain("climon kill --all");
    expect(helpText).toContain("Kill or remove all active sessions");
  });

  test("helpText points config users at config help", () => {
    expect(helpText).toContain("climon config --help");
  });
});

describe("parseArgs", () => {
  test("defaults to shell with no args", () => {
    expect(parseArgs([])).toEqual({ command: "shell" });
  });

  test("parses help flags", () => {
    expect(parseArgs(["--help"])).toEqual({ command: "help" });
    expect(parseArgs(["-h"])).toEqual({ command: "help" });
  });

  test("parses version flags", () => {
    expect(parseArgs(["--version"])).toEqual({ command: "version" });
    expect(parseArgs(["-v"])).toEqual({ command: "version" });
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

  test("parses server with --enable-remotes", () => {
    expect(parseArgs(["server", "--enable-remotes", "--port", "9000"])).toEqual({
      command: "server",
      port: 9000,
      enableRemotes: true
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
    expect(parseArgs(["kill", "--all"])).toEqual({ command: "kill-all" });
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


  test("parses leading session flags before the command", () => {
    expect(parseArgs(["--priority", "800", "--color", "red", "--name", "dev", "npm", "run", "dev"]))
      .toEqual({ command: "run", argv: ["npm", "run", "dev"], headless: false, priority: 800, color: "red", name: "dev" });
  });

  test("supports --flag=value form", () => {
    expect(parseArgs(["--priority=250", "--color=blue", "bash"]))
      .toEqual({ command: "run", argv: ["bash"], headless: false, priority: 250, color: "blue" });
  });

  test("parses --color auto for monitored sessions", () => {
    expect(parseArgs(["--color", "Auto", "bash"]))
      .toEqual({ command: "run", argv: ["bash"], headless: false, color: "auto" });
  });

  test("stops parsing flags at the first non-flag token", () => {
    // The --color here belongs to the monitored command, not climon.
    expect(parseArgs(["npm", "run", "build", "--color"]))
      .toEqual({ command: "run", argv: ["npm", "run", "build", "--color"], headless: false });
  });

  test("works with the explicit run subcommand and --headless", () => {
    expect(parseArgs(["run", "--headless", "--priority", "10", "sleep", "30"]))
      .toEqual({ command: "run", argv: ["sleep", "30"], headless: true, priority: 10 });
  });

  test("rejects an invalid priority", () => {
    expect(() => parseArgs(["--priority", "2000", "bash"])).toThrow(/0 and 1000/);
  });

  test("rejects an invalid color", () => {
    expect(() => parseArgs(["--color", "orange", "bash"])).toThrow(/must be one of/);
  });

  test("bare flags with no command defaults to shell", () => {
    expect(parseArgs(["--name", "my session"])).toEqual({
      command: "shell",
      name: "my session"
    });
    expect(parseArgs(["--priority", "5", "--color", "blue"])).toEqual({
      command: "shell",
      priority: 5,
      color: "blue"
    });
  });
});
