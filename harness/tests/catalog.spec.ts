import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadHarnessCases } from "../src/catalog.js";

async function catalogue(markdown: string) {
  const dir = await mkdtemp(join(tmpdir(), "climon-catalog-"));
  await writeFile(join(dir, "cases.md"), markdown);
  return loadHarnessCases(dir);
}

test("loads an automated case from a yaml harness block", async () => {
  const cases = await catalogue(`
## CIH-01 — Headless lifecycle

- **ID:** CIH-01

\`\`\`yaml harness
status: automated
suite: smoke
scenario: client-server.headless-dashboard
platforms: [macos, linux, windows]
timeoutSeconds: 90
\`\`\`
`);

  expect(cases).toEqual([
    {
      id: "CIH-01",
      title: "Headless lifecycle",
      sourceFile: "cases.md",
      status: "automated",
      suite: "smoke",
      scenario: "client-server.headless-dashboard",
      platforms: ["macos", "linux", "windows"],
      timeoutSeconds: 90,
    },
  ]);
});

test("rejects an automated case with an unknown field", async () => {
  await expect(
    catalogue(`
## CIH-01 — Invalid
- **ID:** CIH-01
\`\`\`yaml harness
status: automated
suite: smoke
scenario: client-server.headless-dashboard
platforms: [linux]
timeoutSeconds: 90
command: rm -rf /
\`\`\`
`)
  ).rejects.toThrow("unsupported harness field: command");
});

test("rejects duplicate case IDs with a clear duplicate-ID message", async () => {
  await expect(
    catalogue(`
## CIH-01 — First
- **ID:** CIH-01
\`\`\`yaml harness
status: automated
suite: smoke
scenario: client-server.headless-dashboard
platforms: [linux]
timeoutSeconds: 90
\`\`\`
## CIH-01 — Second
- **ID:** CIH-01
\`\`\`yaml harness
status: manual
suite: smoke
scenario: client-server.attached-pty
platforms: [linux]
timeoutSeconds: 60
\`\`\`
`)
  ).rejects.toThrow("duplicate ID: CIH-01");
});

test("rejects a timeout value outside 1 through 600", async () => {
  await expect(
    catalogue(`
## CIH-01 — Invalid timeout
- **ID:** CIH-01
\`\`\`yaml harness
status: automated
suite: smoke
scenario: client-server.headless-dashboard
platforms: [linux]
timeoutSeconds: 0
\`\`\`
`)
  ).rejects.toThrow("timeoutSeconds must be an integer from 1 to 600");
});

test("loads real docs/manual-tests directory and finds CIH-01 and CIH-02 as automated smoke cases", async () => {
  const dir = resolve(import.meta.dirname, "../../docs/manual-tests");
  const cases = await loadHarnessCases(dir);

  const cih01 = cases.find((c) => c.id === "CIH-01");
  const cih02 = cases.find((c) => c.id === "CIH-02");

  expect(cih01).toBeDefined();
  expect(cih01?.status).toBe("automated");
  expect(cih01?.suite).toBe("smoke");

  expect(cih02).toBeDefined();
  expect(cih02?.status).toBe("automated");
  expect(cih02?.suite).toBe("smoke");
});
