import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSessionDefaults } from "../src/launcher.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "climon-defaults-"));
}

describe("resolveSessionDefaults", () => {
  test("CLI flags win over config", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".climon"), { recursive: true });
    writeFileSync(
      join(home, ".climon", "config.json"),
      JSON.stringify({ session: { color: "red", priority: 500 } })
    );
    const out = resolveSessionDefaults(
      { color: "green", priority: 20 },
      { CLIMON_HOME: join(home, ".climon") },
      home
    );
    expect(out.color).toBe("green");
    expect(out.priority).toBe(20);
  });

  test("falls back to hierarchical config when flags absent", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".climon"), { recursive: true });
    writeFileSync(
      join(home, ".climon", "config.json"),
      JSON.stringify({ session: { color: "red", priority: 500 } })
    );
    const out = resolveSessionDefaults({}, { CLIMON_HOME: join(home, ".climon") }, home);
    expect(out.color).toBe("red");
    expect(out.priority).toBe(500);
  });

  test("falls back to built-in defaults when neither is set", () => {
    const home = tmpHome();
    const out = resolveSessionDefaults({}, { CLIMON_HOME: join(home, ".climon") }, home);
    expect(out.color).toBeNull();
    expect(out.priority).toBe(500);
  });

  test("'none' color in config resolves to null", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".climon"), { recursive: true });
    writeFileSync(
      join(home, ".climon", "config.json"),
      JSON.stringify({ session: { color: "none" } })
    );
    const out = resolveSessionDefaults({}, { CLIMON_HOME: join(home, ".climon") }, home);
    expect(out.color).toBeNull();
  });

  test("explicit null color flag is respected over config", () => {
    const home = tmpHome();
    mkdirSync(join(home, ".climon"), { recursive: true });
    writeFileSync(
      join(home, ".climon", "config.json"),
      JSON.stringify({ session: { color: "red" } })
    );
    const out = resolveSessionDefaults({ color: null }, { CLIMON_HOME: join(home, ".climon") }, home);
    expect(out.color).toBeNull();
  });
});
