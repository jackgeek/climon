import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bridgeManifest,
  releaseBaseUrl,
  type BridgeManifest,
} from "../scripts/bridge-release.js";

describe("bridgeManifest", () => {
  test("repoints artifact URLs at jackgeek/climon and drops encryption", () => {
    const input: BridgeManifest = {
      version: "9.9.9",
      encryption: "aes-256-gcm-scrypt-v1",
      artifacts: {
        "linux-x64": {
          url: "https://github.com/jackgeek/climon-releases/releases/download/v9.9.9/climon-linux-x64.zip",
          sig: "https://github.com/jackgeek/climon-releases/releases/download/v9.9.9/climon-linux-x64.zip.sig",
        },
      },
    };

    const out = bridgeManifest(input, "v9.9.9");

    expect(out).not.toHaveProperty("encryption");
    expect(out.version).toBe("9.9.9");
    expect(out.artifacts["linux-x64"]!.url).toBe(
      "https://github.com/jackgeek/climon/releases/download/v9.9.9/climon-linux-x64.zip"
    );
    expect(out.artifacts["linux-x64"]!.sig).toBe(
      "https://github.com/jackgeek/climon/releases/download/v9.9.9/climon-linux-x64.zip.sig"
    );
  });

  test("is idempotent on an already-jackgeek/climon manifest", () => {
    const base = releaseBaseUrl("v1.2.3");
    const already: BridgeManifest = {
      version: "1.2.3",
      artifacts: {
        "darwin-arm64": {
          url: `${base}/climon-darwin-arm64.zip`,
          sig: `${base}/climon-darwin-arm64.zip.sig`,
        },
      },
    };
    expect(bridgeManifest(already, "v1.2.3")).toEqual(already);
  });
});

describe("bridge-release --dry-run CLI", () => {
  test("prints the bridged manifest with jackgeek/climon URLs and no encryption", () => {
    const dir = mkdtempSync(join(process.cwd(), ".copilot-tmp-bridge-"));
    try {
      const manifest: BridgeManifest = {
        version: "9.9.9",
        encryption: undefined,
        artifacts: {
          "linux-x64": {
            url: "https://github.com/jackgeek/climon-releases/releases/download/v9.9.9/climon-linux-x64.zip",
            sig: "https://github.com/jackgeek/climon-releases/releases/download/v9.9.9/climon-linux-x64.zip.sig",
          },
        },
      };
      writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({ ...manifest, encryption: null })
      );

      const out = execFileSync(
        "bun",
        ["scripts/bridge-release.ts", "v9.9.9", "--dry-run"],
        { encoding: "utf8", env: { ...process.env, DIST_DIR: dir } }
      );

      const parsed = JSON.parse(out);
      expect(parsed).not.toHaveProperty("encryption");
      expect(parsed.artifacts["linux-x64"].url).toContain(
        "jackgeek/climon/releases/download"
      );
      expect(parsed.artifacts["linux-x64"].url).not.toContain("climon-releases");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
