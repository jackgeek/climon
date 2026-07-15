import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPeerDependencyViolations } from "../scripts/check-peer-deps.js";

interface FakePackage {
  name: string;
  version: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function makeNodeModules(packages: FakePackage[]): string {
  const nodeModules = mkdtempSync(join(tmpdir(), "climon-peers-"));
  for (const pkg of packages) {
    const dir = join(nodeModules, ...pkg.name.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  }
  return nodeModules;
}

describe("findPeerDependencyViolations", () => {
  test("flags a peer installed on a version outside the declared range", () => {
    // The real regression: addon-fit's peer @xterm/xterm ^5 vs installed 6.
    const nodeModules = makeNodeModules([
      {
        name: "@xterm/addon-fit",
        version: "0.10.0",
        peerDependencies: { "@xterm/xterm": "^5.0.0" }
      },
      { name: "@xterm/xterm", version: "6.0.0" }
    ]);

    const violations = findPeerDependencyViolations(nodeModules);

    expect(violations).toEqual([
      "@xterm/addon-fit@0.10.0 requires @xterm/xterm@^5.0.0, but @xterm/xterm@6.0.0 is installed"
    ]);
  });

  test("passes when the installed peer satisfies the range", () => {
    const nodeModules = makeNodeModules([
      {
        name: "@xterm/addon-fit",
        version: "0.11.0",
        peerDependencies: { "@xterm/xterm": "^6.0.0" }
      },
      { name: "@xterm/xterm", version: "6.0.0" }
    ]);

    expect(findPeerDependencyViolations(nodeModules)).toEqual([]);
  });

  test("ignores peers declared optional", () => {
    const nodeModules = makeNodeModules([
      {
        name: "widget",
        version: "1.0.0",
        peerDependencies: { react: "^18.0.0" },
        peerDependenciesMeta: { react: { optional: true } }
      },
      { name: "react", version: "19.2.0" }
    ]);

    expect(findPeerDependencyViolations(nodeModules)).toEqual([]);
  });

  test("ignores peers that are not installed", () => {
    const nodeModules = makeNodeModules([
      {
        name: "widget",
        version: "1.0.0",
        peerDependencies: { "not-installed": "^1.0.0" }
      }
    ]);

    expect(findPeerDependencyViolations(nodeModules)).toEqual([]);
  });
});
