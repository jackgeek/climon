import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Safety net for the whole test run: force the *default* CLIMON_HOME onto a
// throwaway temp directory before any test loads. climon's getClimonHome()
// falls back to ~/.climon whenever CLIMON_HOME is unset, so a test that calls
// climon code in-process without isolating (or spawns a child that inherits
// the environment) would otherwise read or mutate a developer's real ~/.climon
// — including a running dashboard server's state. Individual tests still set
// their own per-test CLIMON_HOME; this only governs the inherited default.
//
// This deliberately overrides any inherited CLIMON_HOME: no test legitimately
// needs the real home, so we never want a value from the developer's shell to
// leak production state into the suite.
const fallbackHome = mkdtempSync(join(tmpdir(), "climon-test-home-"));
process.env.CLIMON_HOME = fallbackHome;

process.on("exit", () => {
  try {
    rmSync(fallbackHome, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; leaked sockets/daemons must not fail the run.
  }
});
