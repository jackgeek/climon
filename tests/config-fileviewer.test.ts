import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import {
  CONFIG_SETTINGS,
  dashboardWritableSettings,
  findConfigSetting
} from "../src/config-settings.js";
import { isFeatureEnabled } from "../src/features.js";

async function withConfigHome<T>(
  name: string,
  config: Record<string, unknown>,
  run: (home: string) => Promise<T>
): Promise<T> {
  const home = join(process.cwd(), ".copilot-tmp", `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify(config));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("fileViewer config settings", () => {
  test("file viewer toggle is the feature.fileViewer flag (default disabled)", () => {
    const setting = findConfigSetting("feature.fileViewer");
    expect(setting).toBeDefined();
    expect(setting?.type).toBe("string");
    expect(setting?.defaultValue).toBe("disabled");
  });

  test("declares fileViewer.maxFileSizeBytes (default 2 MiB)", () => {
    const setting = findConfigSetting("fileViewer.maxFileSizeBytes");
    expect(setting?.type).toBe("number");
    expect(setting?.defaultValue).toBe(2 * 1024 * 1024);
  });

  test("maxFileSizeBytes rejects non-positive / non-integer values", () => {
    const setting = findConfigSetting("fileViewer.maxFileSizeBytes");
    expect(() => setting?.validate?.(0)).toThrow();
    expect(() => setting?.validate?.(-1)).toThrow();
    expect(() => setting?.validate?.(1.5)).toThrow();
    expect(() => setting?.validate?.(1024)).not.toThrow();
  });

  test("no fileViewer.* setting is dashboard-writable (SEC-7)", () => {
    const writable = dashboardWritableSettings().map((s) => s.path);
    expect(writable.some((p) => p.startsWith("fileViewer."))).toBe(false);
    expect(writable.includes("feature.fileViewer")).toBe(false);
    expect(CONFIG_SETTINGS.some((s) => s.path.startsWith("fileViewer."))).toBe(true);
  });

  test("loadConfig preserves fileViewer values from persisted config", async () => {
    await withConfigHome(
      "climon-fileviewer",
      {
        version: 1,
        server: { host: "127.0.0.1", port: 3131 },
        terminal: { clampBrowserToHost: true, detachPrefix: 28, setTitle: true },
        attention: { idleSeconds: 10 },
        feature: { fileViewer: "enabled" },
        fileViewer: { maxFileSizeBytes: 4096 }
      },
      async (home) => {
        const config = await loadConfig({ CLIMON_HOME: home } as NodeJS.ProcessEnv);
        expect(isFeatureEnabled(config, "fileViewer")).toBe(true);
        expect(config.fileViewer?.maxFileSizeBytes).toBe(4096);
      }
    );
  });

  test("loadConfig backfills fileViewer defaults for existing config files", async () => {
    await withConfigHome(
      "climon-fileviewer-backfill",
      {
        version: 1,
        server: { host: "127.0.0.1", port: 3131 },
        terminal: { clampBrowserToHost: true, detachPrefix: 28, setTitle: true },
        attention: { idleSeconds: 10 }
      },
      async (home) => {
        const config = await loadConfig({ CLIMON_HOME: home } as NodeJS.ProcessEnv);
        expect(isFeatureEnabled(config, "fileViewer")).toBe(false);
        expect(config.fileViewer?.maxFileSizeBytes).toBe(2 * 1024 * 1024);
      }
    );
  });
});
