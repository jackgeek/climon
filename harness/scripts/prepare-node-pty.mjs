/**
 * prepare-node-pty.mjs
 *
 * Ensures that node-pty's spawn-helper binaries are executable.  A fresh `bun
 * install` on macOS has been observed to leave the prebuilt helper files
 * non-executable (mode 0o644), which causes node-pty to fail at runtime.
 *
 * Usage (CLI):
 *   node harness/scripts/prepare-node-pty.mjs
 *
 * Set CLIMON_NODE_PTY_ROOT to override the node_modules root (useful in tests).
 *
 * Exported API:
 *   prepareNodePty(nodeModulesRoot?: string) → Promise<void>
 */

import { chmod, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Finds every `spawn-helper` regular file under
 * `<nodeModulesRoot>/node-pty/prebuilds/ * /spawn-helper` and chmods each one
 * to 0o755.  Does nothing on Windows.  Does not throw if the prebuilds
 * directory or helper files are absent (source builds via node-gyp do not
 * produce prebuilds).  Does surface chmod errors for files that were found.
 *
 * @param {string} [nodeModulesRoot] - Path to the node_modules directory.
 *   Defaults to `CLIMON_NODE_PTY_ROOT` env var if set, otherwise
 *   `node_modules` relative to the current working directory.
 * @returns {Promise<void>}
 */
export async function prepareNodePty(nodeModulesRoot) {
  if (process.platform === "win32") {
    return;
  }

  const root =
    nodeModulesRoot ??
    process.env.CLIMON_NODE_PTY_ROOT ??
    resolve(process.cwd(), "node_modules");

  const prebuildsDir = join(root, "node-pty", "prebuilds");

  let archEntries;
  try {
    archEntries = await readdir(prebuildsDir, { withFileTypes: true });
  } catch {
    // prebuilds directory absent — source build, nothing to do.
    return;
  }

  const errors = [];

  for (const entry of archEntries) {
    if (!entry.isDirectory()) continue;

    const helperPath = join(prebuildsDir, entry.name, "spawn-helper");

    let s;
    try {
      s = await stat(helperPath);
    } catch {
      // No spawn-helper for this arch — skip silently.
      continue;
    }

    if (!s.isFile()) continue;

    try {
      await chmod(helperPath, 0o755);
    } catch (err) {
      errors.push(`chmod ${helperPath}: ${String(err)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `prepare-node-pty: failed to chmod spawn-helper files:\n${errors.join("\n")}`
    );
  }
}

// CLI entry point — robust cross-platform detection.
// path.resolve handles relative argv[1] (e.g. "harness/scripts/prepare-node-pty.mjs")
// and fileURLToPath handles Windows drive-letter URLs that the old `file://${argv1}`
// pattern broke (C: was treated as the URL hostname).
if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareNodePty().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
