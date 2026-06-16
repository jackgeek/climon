import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureEulaAccepted, isEulaAccepted } from "../src/eula/accept.js";

let home: string;
let env: NodeJS.ProcessEnv;
let printed: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "climon-"));
  env = { ...process.env, CLIMON_HOME: home };
  printed = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const io = (answer: string) => ({
  env,
  print: (s: string) => printed.push(s),
  prompt: async () => answer,
});

describe("ensureEulaAccepted", () => {
  test("accepts when the user types I AGREE (any case)", async () => {
    const ok = await ensureEulaAccepted({ ...io("  i agree ") });
    expect(ok).toBe(true);
    expect(isEulaAccepted(env)).toBe(true);
    expect(printed.join("\n")).toContain("Brodie Jack Allan");
  });

  test("rejects any other input and does not record acceptance", async () => {
    const ok = await ensureEulaAccepted({ ...io("no") });
    expect(ok).toBe(false);
    expect(isEulaAccepted(env)).toBe(false);
  });

  test("skips the prompt when already accepted", async () => {
    await ensureEulaAccepted({ ...io("i agree") });
    let prompted = false;
    const ok = await ensureEulaAccepted({
      env,
      print: () => {},
      prompt: async () => {
        prompted = true;
        return "no";
      },
    });
    expect(ok).toBe(true);
    expect(prompted).toBe(false);
  });

  test("non-interactive accepts with acceptEula=true without prompting", async () => {
    let prompted = false;
    const ok = await ensureEulaAccepted({
      env,
      acceptEula: true,
      interactive: false,
      print: () => {},
      prompt: async () => {
        prompted = true;
        return "";
      },
    });
    expect(ok).toBe(true);
    expect(prompted).toBe(false);
    expect(isEulaAccepted(env)).toBe(true);
  });

  test("non-interactive without acceptEula fails", async () => {
    const ok = await ensureEulaAccepted({
      env,
      interactive: false,
      print: () => {},
      prompt: async () => "",
    });
    expect(ok).toBe(false);
    expect(isEulaAccepted(env)).toBe(false);
  });
});
