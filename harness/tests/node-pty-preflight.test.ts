import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { prepareNodePty } from "../src/node-pty-preflight.js";

function makeWorkspace(name: string): string {
  const workspace = resolve(
    import.meta.dir,
    "..",
    ".test-workspace",
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

function spawnHelperPath(workspace: string): string {
  return join(
    workspace,
    "node_modules",
    "node-pty",
    "prebuilds",
    "darwin-arm64",
    "spawn-helper"
  );
}

describe("prepareNodePty", () => {
  test.skipIf(process.platform === "win32")(
    "chmods node-pty spawn-helper files to 0755 outside Windows",
    async () => {
      const workspace = makeWorkspace("chmod");
      const helper = spawnHelperPath(workspace);

      try {
        mkdirSync(dirname(helper), { recursive: true });
        writeFileSync(helper, "");
        chmodSync(helper, 0o644);

        await prepareNodePty(workspace);

        expect(statSync(helper).mode & 0o777).toBe(0o755);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  );

  test("leaves spawn-helper files unchanged for injected win32 runs", async () => {
    const workspace = makeWorkspace("win32");
    const helper = spawnHelperPath(workspace);

    try {
      mkdirSync(dirname(helper), { recursive: true });
      writeFileSync(helper, "");
      chmodSync(helper, 0o644);
      const before = statSync(helper).mode & 0o777;

      await prepareNodePty(workspace, "win32");

      expect(statSync(helper).mode & 0o777).toBe(before);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
