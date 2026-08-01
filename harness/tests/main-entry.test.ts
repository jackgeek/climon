import { describe, expect, test } from "bun:test";

const mainModule = await import("../src/main.js").catch(() => null);
const isHarnessEntrypoint = (
  mainModule as { isHarnessEntrypoint?: (moduleUrl: string, argvEntry?: string) => boolean } | null
)?.isHarnessEntrypoint;
const resolveHarnessRoot = (
  mainModule as {
    resolveHarnessRoot?: (moduleUrl: string, env?: NodeJS.ProcessEnv) => string;
  } | null
)?.resolveHarnessRoot;

function requireIsHarnessEntrypoint(): NonNullable<typeof isHarnessEntrypoint> {
  expect(isHarnessEntrypoint).toBeDefined();
  return isHarnessEntrypoint!;
}

function requireResolveHarnessRoot(): NonNullable<typeof resolveHarnessRoot> {
  expect(resolveHarnessRoot).toBeDefined();
  return resolveHarnessRoot!;
}

describe("harness main entrypoint", () => {
  test("detects the compiled Node bundle as the executable entry", () => {
    const isEntrypoint = requireIsHarnessEntrypoint();
    const bundlePath = "/repo/.test-tmp/e2e-harness/tooling/harness-node.mjs";

    expect(isEntrypoint(`file://${bundlePath}`, bundlePath)).toBe(true);
    expect(isEntrypoint(`file://${bundlePath}`, "/repo/harness/src/main.ts")).toBe(
      false
    );
    expect(isEntrypoint(`file://${bundlePath}`)).toBe(false);
  });

  test("prefers the launcher-provided repository root override", () => {
    const resolveRoot = requireResolveHarnessRoot();

    expect(
      resolveRoot("file:///repo/.test-tmp/e2e-harness/tooling/harness-node.mjs", {
        CLIMON_HARNESS_ROOT: "/repo",
      })
    ).toBe("/repo");
  });
});
