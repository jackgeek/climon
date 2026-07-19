import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import yaml from "yaml";
import type {
  HarnessCase,
  HarnessPlatform,
  HarnessStatus,
  ScenarioKey,
} from "./types.js";
import { HarnessError } from "./types.js";

const ALLOWED_FIELDS = new Set([
  "status",
  "suite",
  "scenario",
  "platforms",
  "timeoutSeconds",
]);

const SCENARIOS = new Set<ScenarioKey>([
  "client-server.headless-dashboard",
  "client-server.attached-pty",
]);

const HEADING_RE = /^## ([A-Z0-9-]+) [—-] (.+)$/;
const ID_RE = /^- \*\*ID:\*\* ([A-Z0-9-]+)$/;

function fail(file: string, id: string | undefined, msg: string): never {
  const loc = id ? `${file} [${id}]` : file;
  throw new HarnessError("catalogue", `${loc}: ${msg}`);
}

export async function loadHarnessCases(
  manualTestsDir: string
): Promise<HarnessCase[]> {
  const entries = await readdir(manualTestsDir, { withFileTypes: true });
  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();

  const cases: HarnessCase[] = [];
  const seenIds = new Map<string, string>();

  for (const fileName of mdFiles) {
    const filePath = join(manualTestsDir, fileName);
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n");

    let currentId: string | undefined;
    let currentTitle: string | undefined;
    let pendingIdLine: string | undefined;
    let inHarnessBlock = false;
    let harnessLines: string[] = [];
    let caseHasBlock = false;
    // Track non-harness fenced blocks so we skip content inside them.
    let skipBlockFenceLen = 0; // 0 means not in a skip block

    for (const line of lines) {

      // Detect opening of a non-harness fenced block (4+ backticks, or 3+
      // backticks with anything other than "yaml harness"). We must not be
      // inside a harness block (inHarnessBlock) or another skip block.
      if (!inHarnessBlock && skipBlockFenceLen === 0) {
        const fenceMatch = /^(`{3,})([^`]*)$/.exec(line.trimEnd());
        if (fenceMatch) {
          const fenceLen = fenceMatch[1].length;
          const info = fenceMatch[2].trim();
          if (info !== "yaml harness") {
            // Non-harness fenced block — skip until matching close fence.
            skipBlockFenceLen = fenceLen;
            continue;
          }
          // Otherwise fall through to the harness block detection below.
        }
      }

      // Close a skip block when we see a line that is only backticks with
      // count >= the opening fence length.
      if (skipBlockFenceLen > 0) {
        const closeMatch = /^`+$/.exec(line.trimEnd());
        if (closeMatch && closeMatch[0].length >= skipBlockFenceLen) {
          skipBlockFenceLen = 0;
        }
        continue;
      }

      if (inHarnessBlock) {
        if (line.trimEnd() === "```") {
          inHarnessBlock = false;
          const src = harnessLines.join("\n");
          const parsed = yaml.parse(src) as Record<string, unknown>;

          if (parsed === null || typeof parsed !== "object") {
            fail(fileName, currentId, "harness block is not a YAML object");
          }

          // Reject unknown fields first
          for (const key of Object.keys(parsed)) {
            if (!ALLOWED_FIELDS.has(key)) {
              fail(fileName, currentId, `unsupported harness field: ${key}`);
            }
          }

          // Validate status
          const status = parsed.status as string;
          if (status !== "automated" && status !== "manual") {
            fail(
              fileName,
              currentId,
              `status must be "automated" or "manual", got: ${status}`
            );
          }

          // Validate suite
          const suite = parsed.suite as string;
          if (typeof suite !== "string" || suite.trim() === "") {
            fail(fileName, currentId, "suite must be a non-empty string");
          }

          // Validate scenario
          const scenario = parsed.scenario as string;
          if (!SCENARIOS.has(scenario as ScenarioKey)) {
            fail(
              fileName,
              currentId,
              `unknown scenario: ${scenario}`
            );
          }

          // Validate platforms
          const rawPlatforms = parsed.platforms;
          if (!Array.isArray(rawPlatforms) || rawPlatforms.length === 0) {
            fail(
              fileName,
              currentId,
              "platforms must be a non-empty array"
            );
          }
          const validPlatforms = new Set<string>(["macos", "linux", "windows"]);
          const seenPlatforms = new Set<string>();
          for (const p of rawPlatforms as unknown[]) {
            if (typeof p !== "string" || !validPlatforms.has(p)) {
              fail(
                fileName,
                currentId,
                `invalid platform: ${p}`
              );
            }
            if (seenPlatforms.has(p)) {
              fail(
                fileName,
                currentId,
                `duplicate platform: ${p}`
              );
            }
            seenPlatforms.add(p);
          }
          const platforms = rawPlatforms as HarnessPlatform[];

          // Validate timeoutSeconds
          const timeoutSeconds = parsed.timeoutSeconds as number;
          if (
            typeof timeoutSeconds !== "number" ||
            !Number.isInteger(timeoutSeconds) ||
            timeoutSeconds < 1 ||
            timeoutSeconds > 600
          ) {
            fail(
              fileName,
              currentId,
              `timeoutSeconds must be an integer from 1 to 600, got: ${timeoutSeconds}`
            );
          }

          if (!currentId) {
            fail(fileName, undefined, "harness block found without a preceding ID");
          }

          if (caseHasBlock) {
            fail(
              fileName,
              currentId,
              "duplicate harness block for the same case"
            );
          }

          // Check for globally duplicate IDs
          const existingEntry = seenIds.get(currentId);
          if (existingEntry !== undefined) {
            fail(
              fileName,
              currentId,
              `duplicate ID: ${currentId} (first seen in ${existingEntry})`
            );
          }

          seenIds.set(currentId, fileName);
          caseHasBlock = true;

          cases.push({
            id: currentId,
            title: currentTitle!,
            sourceFile: basename(fileName),
            status: status as HarnessStatus,
            suite,
            scenario: scenario as ScenarioKey,
            platforms,
            timeoutSeconds,
          });

          harnessLines = [];
        } else {
          harnessLines.push(line);
        }
        continue;
      }

      // Detect heading — resets current case context
      const headingMatch = HEADING_RE.exec(line.trimEnd());
      if (headingMatch) {
        currentId = headingMatch[1];
        currentTitle = headingMatch[2];
        pendingIdLine = undefined;
        caseHasBlock = false;
        continue;
      }

      // Detect ID line — record it; validate it matches the heading ID only
      // when we encounter a harness block (not all manual-test files have
      // consistent heading/ID alignment).
      const idMatch = ID_RE.exec(line.trim());
      if (idMatch) {
        pendingIdLine = idMatch[1];
        continue;
      }

      // Detect harness fenced block opening
      if (line.trimEnd() === "```yaml harness") {
        if (!pendingIdLine) {
          fail(
            fileName,
            currentId,
            "harness block found without a preceding `- **ID:** <id>` line"
          );
        }
        if (currentId && pendingIdLine !== currentId) {
          fail(
            fileName,
            currentId,
            `ID line "${pendingIdLine}" does not match heading ID "${currentId}"`
          );
        }
        inHarnessBlock = true;
        harnessLines = [];
        continue;
      }
    }

    if (inHarnessBlock) {
      fail(fileName, currentId, "unterminated harness block");
    }
  }

  cases.sort((a, b) => a.id.localeCompare(b.id));
  return cases;
}
