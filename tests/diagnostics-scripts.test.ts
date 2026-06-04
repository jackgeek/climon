import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const homeScript = join(root, "scripts", "diagnostics", "Collect-ClimonHomeDiagnostics.ps1");
const devboxScript = join(root, "scripts", "diagnostics", "Collect-ClimonDevboxDiagnostics.ps1");

function readScript(path: string): string {
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, "utf8");
}

describe("PowerShell diagnostics scripts", () => {
  test("home diagnostics collect the ingest and tunnel hosting evidence", () => {
    const script = readScript(homeScript);

    expect(script).toContain("param(");
    expect(script).toContain("[switch]$Json");
    expect(script).toContain("remote-host.json");
    expect(script).toContain("ingest.pid");
    expect(script).toContain("Test-TcpPort");
    expect(script).toContain("devtunnel --version");
    expect(script).toContain("devtunnel list");
    expect(script).toContain("devtunnel port list");
    expect(script).toContain("connectToken");
    expect(script).toContain("<redacted>");
  });

  test("devbox diagnostics collect uplink, config, and tunnel-forward evidence", () => {
    const script = readScript(devboxScript);

    expect(script).toContain("param(");
    expect(script).toContain("[switch]$Json");
    expect(script).toContain("uplink.pid");
    expect(script).toContain("remote.enabled");
    expect(script).toContain("remote.tunnelId");
    expect(script).toContain("remote.tunnelToken");
    expect(script).toContain("remote.port");
    expect(script).toContain("Test-TcpPort");
    expect(script).toContain("devtunnel --version");
    expect(script).toContain("<redacted>");
  });
});
