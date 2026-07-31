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
  test("returns successfully when node-pty prebuilds are absent", async () => {
    let readdirCalls = 0;
    let statCalls = 0;
    let chmodCalls = 0;
    const missing = Object.assign(new Error("missing prebuilds"), {
      code: "ENOENT",
    });

    await prepareNodePty("/virtual/workspace", "darwin", {
      async readdir() {
        readdirCalls += 1;
        throw missing;
      },
      async stat() {
        statCalls += 1;
        throw new Error("stat should not run when prebuilds are absent");
      },
      async chmod() {
        chmodCalls += 1;
      },
    });

    expect(readdirCalls).toBe(1);
    expect(statCalls).toBe(0);
    expect(chmodCalls).toBe(0);
  });

  test("propagates non-ENOENT filesystem failures", async () => {
    let readdirCalls = 0;
    const failure = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });

    await expect(
      prepareNodePty("/virtual/workspace", "darwin", {
        async readdir() {
          readdirCalls += 1;
          throw failure;
        },
        async stat() {
          throw new Error("stat should not run when prebuilds scan fails");
        },
        async chmod() {
          throw new Error("chmod should not run when prebuilds scan fails");
        },
      })
    ).rejects.toBe(failure);

    expect(readdirCalls).toBe(1);
  });

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
