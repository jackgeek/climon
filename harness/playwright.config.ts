import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const platform =
  process.platform === "darwin"
    ? "macos"
    : process.platform === "win32"
    ? "windows"
    : "linux";

const root = resolve(import.meta.dirname, "..");

const artifactRoot =
  process.env.CLIMON_HARNESS_ARTIFACT_DIR ??
  resolve(root, ".test-tmp", "harness", platform);

export default defineConfig({
  testDir: resolve(root, "harness/tests"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: resolve(artifactRoot, "playwright"),
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(artifactRoot, "playwright-results.json") }],
  ],
  use: {
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
