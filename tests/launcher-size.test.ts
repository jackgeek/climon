import { describe, expect, test } from "bun:test";
import { resolveLaunchSize } from "../src/launcher.js";

describe("resolveLaunchSize", () => {
  test("reads CLIMON_COLS and CLIMON_ROWS", () => {
    const env = { CLIMON_COLS: "120", CLIMON_ROWS: "40" } as NodeJS.ProcessEnv;
    expect(resolveLaunchSize(env)).toEqual({ cols: 120, rows: 40 });
  });

  test("falls back to 80x24 when unset", () => {
    expect(resolveLaunchSize({} as NodeJS.ProcessEnv)).toEqual({ cols: 80, rows: 24 });
  });

  test("falls back to 80x24 when non-numeric or non-positive", () => {
    const env = { CLIMON_COLS: "abc", CLIMON_ROWS: "0" } as NodeJS.ProcessEnv;
    expect(resolveLaunchSize(env)).toEqual({ cols: 80, rows: 24 });
  });
});
