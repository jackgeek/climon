import { describe, expect, test } from "bun:test";
import { buildRunArgs } from "../src/server/server.js";

describe("buildRunArgs", () => {
  test("adds no metadata flags when none provided", () => {
    expect(buildRunArgs(["npm", "run", "dev"], {})).toEqual([
      "run", "--headless", "npm", "run", "dev"
    ]);
  });

  test("prepends priority, color, and name flags before the command", () => {
    expect(buildRunArgs(["bash"], { priority: 800, color: "red", name: "shell" })).toEqual([
      "run", "--headless", "--priority", "800", "--color", "red", "--name", "shell", "bash"
    ]);
  });

  test("emits --color none to clear an inherited color", () => {
    expect(buildRunArgs(["bash"], { color: null })).toEqual([
      "run", "--headless", "--color", "none", "bash"
    ]);
  });
});
