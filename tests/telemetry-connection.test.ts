import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBEDDED_TELEMETRY_CONNECTION,
  resolveTelemetryConnection,
} from "../src/telemetry/connection.js";
import { writeConfigSetting } from "../src/config.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "climon-"));
  env = { ...process.env, CLIMON_HOME: home };
  delete env.APPLICATIONINSIGHTS_CONNECTION_STRING;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("resolveTelemetryConnection", () => {
  test("returns undefined when telemetry is disabled (default)", () => {
    expect(resolveTelemetryConnection(env)).toBeUndefined();
  });

  test("returns the embedded connection when enabled", () => {
    writeConfigSetting("telemetry.enabled", "true", "global", env);
    expect(resolveTelemetryConnection(env)).toBe(EMBEDDED_TELEMETRY_CONNECTION);
  });

  test("explicit env connection string overrides when enabled", () => {
    writeConfigSetting("telemetry.enabled", "true", "global", env);
    env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=test";
    expect(resolveTelemetryConnection(env)).toBe("InstrumentationKey=test");
  });

  test("env connection string is ignored when telemetry disabled", () => {
    env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=test";
    expect(resolveTelemetryConnection(env)).toBeUndefined();
  });
});
