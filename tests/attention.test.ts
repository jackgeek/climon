import { describe, expect, test } from "bun:test";
import { detectAttention } from "../src/attention.js";

describe("detectAttention", () => {
  test("matches continue prompt", () => {
    const result = detectAttention("Do you want to continue?");
    expect(result.matched).toBe(true);
    expect(result.reason).toBeDefined();
  });

  test("matches yes/no prompt", () => {
    expect(detectAttention("Proceed? [y/n]").matched).toBe(true);
  });

  test("matches press enter prompt", () => {
    expect(detectAttention("Press enter to continue").matched).toBe(true);
  });

  test("matches copilot-style attention request", () => {
    expect(detectAttention("The agent is waiting for your input").matched).toBe(true);
  });

  test("does not match normal output", () => {
    expect(detectAttention("Building project...\nCompiled 42 files").matched).toBe(false);
  });
});
