import pkg from "../package.json";

/**
 * The climon version string, sourced from package.json so the client and the
 * server always report the same value. Bun inlines the imported JSON at
 * build/compile time, so this resolves in the compiled binaries too.
 */
export const VERSION: string = pkg.version;
