import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchBanner, resolveSessionDefaults, chooseAutoSessionColor } from "../src/launcher.js";
import type { AnsiColor, SessionMeta } from "../src/types.js";

const homes: string[] = [];
const homesBase = join(tmpdir(), "climon-defaults-tests");

function safeRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM") {
      throw error;
    }
  }
}

function tmpHome(): string {
  mkdirSync(homesBase, { recursive: true });
  const home = mkdtempSync(join(homesBase, "climon-defaults-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    safeRm(home);
  }
  safeRm(homesBase);
});

function writeSession(home: string, id: string, color?: AnsiColor | null): void {
  mkdirSync(join(home, ".climon", "sessions"), { recursive: true });
  const now = new Date().toISOString();
  const meta: SessionMeta = {
    id,
    command: ["bash"],
    displayCommand: "bash",
    cwd: home,
    status: "running",
    priorityReason: "running",
    socketPath: "tcp://127.0.0.1:0",
    cols: 80,
    rows: 24,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    color
  };
  writeFileSync(join(home, ".climon", "sessions", `${id}.json`), JSON.stringify(meta));
}

describe("chooseAutoSessionColor", () => {
  test("chooses white when no sessions have colors", async () => {
    const home = tmpHome();
    await expect(chooseAutoSessionColor({ CLIMON_HOME: join(home, ".climon") })).resolves.toBe("white");
  });

  test("chooses the first missing color in required order", async () => {
    const home = tmpHome();
    writeSession(home, "s-white", "white");
    writeSession(home, "s-cyan", "cyan");
    writeSession(home, "s-magenta", "magenta");
    writeSession(home, "s-blue", "blue");
    writeSession(home, "s-green", "green");
    writeSession(home, "s-red", "red");
    writeSession(home, "s-black", "black");
    await expect(chooseAutoSessionColor({ CLIMON_HOME: join(home, ".climon") })).resolves.toBe("yellow");
  });

  test("chooses the least-used color and breaks ties by required order", async () => {
    const home = tmpHome();
    for (const color of ["white", "cyan", "magenta", "blue", "yellow", "red", "black"] as const) {
      writeSession(home, `a-${color}`, color);
      writeSession(home, `b-${color}`, color);
    }
    writeSession(home, "one-green", "green");
    await expect(chooseAutoSessionColor({ CLIMON_HOME: join(home, ".climon") })).resolves.toBe("green");
  });
});

describe("launchBanner", () => {
  test("launch banner omits dashboard URL", () => {
    const banner = launchBanner("0.1.16", "session-1");

    expect(banner).toContain("climon v0.1.16 monitoring session session-1");
    expect(banner).not.toContain("dashboard");
    expect(banner).not.toContain("http://");
  });
});

describe("resolveSessionDefaults", () => {
  test("CLI fixed color flags win over config", async () => {
    const home = tmpHome();
    mkdirSync(join(home, ".climon"), { recursive: true });
    writeFileSync(join(home, ".climon", "config.json"), JSON.stringify({ session: { color: "red", priority: 500 } }));
    const out = await resolveSessionDefaults({ color: "green", priority: 20 }, { CLIMON_HOME: join(home, ".climon") }, home);
    expect(out.color).toBe("green");
    expect(out.priority).toBe(20);
  });

  test("fixed config color wins over auto assignment", async () => {
    const home = tmpHome();
    mkdirSync(join(home, ".climon"), { recursive: true });
    writeFileSync(join(home, ".climon", "config.json"), JSON.stringify({ session: { color: "red", priority: 500 } }));
    const out = await resolveSessionDefaults({}, { CLIMON_HOME: join(home, ".climon") }, home);
    expect(out.color).toBe("red");
    expect(out.priority).toBe(500);
  });

  test("auto config color resolves to a concrete color", async () => {
    const home = tmpHome();
    mkdirSync(join(home, ".climon"), { recursive: true });
    writeFileSync(join(home, ".climon", "config.json"), JSON.stringify({ session: { color: "auto" } }));
    const out = await resolveSessionDefaults({}, { CLIMON_HOME: join(home, ".climon") }, home);
    expect(out.color).toBe("white");
  });

  test("'none' color in config resolves to null", async () => {
    const home = tmpHome();
    mkdirSync(join(home, ".climon"), { recursive: true });
    writeFileSync(join(home, ".climon", "config.json"), JSON.stringify({ session: { color: "none" } }));
    const out = await resolveSessionDefaults({}, { CLIMON_HOME: join(home, ".climon") }, home);
    expect(out.color).toBeNull();
  });

  test("explicit null color flag is respected over config", async () => {
    const home = tmpHome();
    mkdirSync(join(home, ".climon"), { recursive: true });
    writeFileSync(join(home, ".climon", "config.json"), JSON.stringify({ session: { color: "red" } }));
    const out = await resolveSessionDefaults({ color: null }, { CLIMON_HOME: join(home, ".climon") }, home);
    expect(out.color).toBeNull();
  });
});
