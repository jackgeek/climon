/**
 * ⚠️ LEGACY TypeScript client — frozen. Fix the Rust client instead.
 *
 * The shipping `climon` *client* is the Rust workspace under `rust/` (crates
 * `climon-cli`, `climon-session`, `climon-pty`, `climon-store`, `climon-config`,
 * `climon-remote`, `climon-install`, `climon-update`, …). This module belongs to
 * the legacy Bun/TypeScript client, kept only for local development and the Bun
 * test suite. Do NOT add features or fix client bugs here — make all client
 * changes in the Rust crates. (The Bun dashboard *server* under `src/server*`
 * and `src/web/` is NOT legacy and is still maintained.)
 */
import { parseSetupOptions, runOnboarding } from "./onboarding.js";

/** `climon setup` entrypoint: re-runs onboarding with any provided flags. */
export async function runSetupCommand(argv: string[]): Promise<number> {
  const options = parseSetupOptions(argv);
  const result = await runOnboarding({ options });
  return result.accepted ? 0 : 1;
}
