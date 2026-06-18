import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  installFilesForPlatform,
  type InstallFile,
} from "../src/install/install-manifest.js";

/**
 * Cross-language install-manifest parity. The shared fixture in
 * `fixtures/install/manifest.json` pins the byte/shape of the install manifest
 * for each platform. Both the Bun client (here) and the Rust client
 * (`rust/climon-install/tests/install_fixtures.rs`) assert their manifest equals
 * this fixture, guaranteeing the non-destructive updater swaps the same files
 * regardless of which installer produced the install.
 */
const FIXTURE: Record<string, InstallFile[]> = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "fixtures", "install", "manifest.json"),
    "utf8"
  )
);

describe("install-manifest cross-language fixture", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    test(`${platform} manifest matches the shared fixture`, () => {
      expect(installFilesForPlatform(platform)).toEqual(FIXTURE[platform]!);
    });
  }
});
