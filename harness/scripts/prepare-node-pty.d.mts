/**
 * Type declarations for prepare-node-pty.mjs.
 *
 * Allows TypeScript tests to import the module with full type safety.
 */

/**
 * Ensures every `spawn-helper` binary under
 * `<nodeModulesRoot>/node-pty/prebuilds/ * /spawn-helper` is executable
 * (mode 0o755).  No-op on Windows.  Does not throw when the prebuilds
 * directory or individual helper files are absent.
 *
 * @param nodeModulesRoot - Path to the `node_modules` directory to scan.
 *   Falls back to `CLIMON_NODE_PTY_ROOT` env var, then `./node_modules`.
 */
export declare function prepareNodePty(nodeModulesRoot?: string): Promise<void>;
