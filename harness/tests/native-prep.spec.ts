import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareNodePty } from "../scripts/prepare-node-pty.mjs";

// All test artifacts are kept in .test-tmp — gitignored, never /tmp.
const testRoot = resolve(
  import.meta.dirname,
  "../../.test-tmp/native-prep"
);

test.beforeEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
  await mkdir(testRoot, { recursive: true });
});

test.afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

// ── Unix behaviour ────────────────────────────────────────────────────────────

test("prepareNodePty: makes spawn-helper executable on non-Windows", async () => {
  if (process.platform === "win32") {
    // On Windows the function is a no-op; covered by the Windows test below.
    return;
  }

  // Build a fake node_modules/node-pty/prebuilds/<arch>/spawn-helper layout.
  const prebuildDir = join(testRoot, "node-pty", "prebuilds", "darwin-arm64");
  await mkdir(prebuildDir, { recursive: true });
  const helperPath = join(prebuildDir, "spawn-helper");
  // Write the file with mode 0o644 — intentionally non-executable.
  await writeFile(helperPath, "#!/bin/sh\necho hello\n", { mode: 0o644 });

  // Confirm it starts non-executable.
  const before = await stat(helperPath);
  expect(before.mode & 0o111).toBe(0);

  // Run the prepare function pointing at our fake node_modules root.
  await prepareNodePty(testRoot);

  // The file should now be executable.
  const after = await stat(helperPath);
  expect(after.mode & 0o111).not.toBe(0);
});

test("prepareNodePty: chmods all spawn-helper files across multiple prebuild dirs", async () => {
  if (process.platform === "win32") return;

  const prebuildsBase = join(testRoot, "node-pty", "prebuilds");
  const archs = ["darwin-arm64", "darwin-x64", "linux-x64"];
  const helperPaths: string[] = [];

  for (const arch of archs) {
    const dir = join(prebuildsBase, arch);
    await mkdir(dir, { recursive: true });
    const helperPath = join(dir, "spawn-helper");
    await writeFile(helperPath, "#!/bin/sh\n", { mode: 0o600 });
    helperPaths.push(helperPath);
  }

  await prepareNodePty(testRoot);

  for (const helperPath of helperPaths) {
    const s = await stat(helperPath);
    expect(s.mode & 0o111, `${helperPath} should be executable`).not.toBe(0);
  }
});

test("prepareNodePty: does not fail when prebuilds directory is absent", async () => {
  // testRoot exists but contains no node-pty directory.
  await expect(prepareNodePty(testRoot)).resolves.toBeUndefined();
});

test("prepareNodePty: does not fail when node-pty directory is entirely absent", async () => {
  // testRoot is completely empty (just mkdir'd by beforeEach).
  await expect(prepareNodePty(testRoot)).resolves.toBeUndefined();
});

// ── Windows behaviour ─────────────────────────────────────────────────────────

test("prepareNodePty: is a no-op on Windows (always resolves without error)", async () => {
  if (process.platform !== "win32") {
    // Simulate the Windows path by calling with a non-existent root.
    // The real Windows guard is tested only on actual Windows runners.
    // Here we only assert the function resolves; the Windows guard is covered
    // by the implementation's platform check.
    await expect(prepareNodePty(testRoot)).resolves.toBeUndefined();
    return;
  }
  await expect(prepareNodePty(testRoot)).resolves.toBeUndefined();
});

// ── Direct-entry detection ────────────────────────────────────────────────────

test("native-prep: direct-entry via relative path invokes prepareNodePty", async () => {
  if (process.platform === "win32") return;

  // Build fixture with a non-executable spawn-helper.
  const prebuildDir = join(testRoot, "node-pty", "prebuilds", "linux-x64");
  await mkdir(prebuildDir, { recursive: true });
  const helperPath = join(prebuildDir, "spawn-helper");
  await writeFile(helperPath, "#!/bin/sh\necho hello\n", { mode: 0o644 });

  const before = await stat(helperPath);
  expect(before.mode & 0o111).toBe(0);

  // Write a probe script that simulates `node harness/scripts/prepare-node-pty.mjs`
  // where process.argv[1] is a *relative* path — the scenario that the buggy
  // `file://${process.argv[1]}` URL construction cannot handle because it turns
  // the first path segment into a URL hostname.
  const projectRoot = resolve(import.meta.dirname, "../..");
  const scriptAbsPath = resolve(
    projectRoot,
    "harness/scripts/prepare-node-pty.mjs"
  );
  const probeScript = join(testRoot, "probe.mjs");
  await writeFile(
    probeScript,
    [
      "// Simulate invocation where argv[1] is a relative path.",
      `process.argv[1] = "harness/scripts/prepare-node-pty.mjs";`,
      `await import(${JSON.stringify(scriptAbsPath)});`,
    ].join("\n")
  );

  await new Promise<void>((res, rej) => {
    execFile(
      process.execPath,
      [probeScript],
      {
        cwd: projectRoot,
        env: { ...process.env, CLIMON_NODE_PTY_ROOT: testRoot },
      },
      (err) => (err ? rej(err) : res())
    );
  });

  const after = await stat(helperPath);
  expect(
    after.mode & 0o111,
    "spawn-helper should be executable after direct invocation with a relative path"
  ).not.toBe(0);
});
