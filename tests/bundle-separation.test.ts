import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const MARKER = "__CLIMON_XTERM_EMBEDDED__";

async function bundleText(entrypoint: string): Promise<string> {
  const result = await Bun.build({ entrypoints: [entrypoint], target: "bun" });
  if (!result.success) {
    throw new AggregateError(result.logs, `failed to bundle ${entrypoint}`);
  }
  const parts = await Promise.all(result.outputs.map((o) => o.text()));
  return parts.join("\n");
}

describe("bundle separation", () => {
  beforeAll(() => {
    // embedded-assets.ts is a generated build artifact (gitignored); ensure it
    // exists with the marker so the server-inclusion assertion is deterministic.
    const embed = resolve(import.meta.dir, "../scripts/embed-assets.ts");
    const out = spawnSync("bun", [embed], { stdio: "inherit" });
    if (out.status !== 0) {
      throw new Error("failed to regenerate embedded assets");
    }
  });

  test("client bundle (src/index.ts) excludes embedded xterm assets", async () => {
    const text = await bundleText("src/index.ts");
    expect(text).not.toContain(MARKER);
  });

  test("server bundle (src/server.ts) includes embedded xterm assets", async () => {
    const text = await bundleText("src/server.ts");
    expect(text).toContain(MARKER);
  });
});
