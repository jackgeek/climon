import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CaseResult, HarnessCase } from "./types.js";
import { loadHarnessCases } from "./catalog.js";

export interface AggregateReport {
  ok: boolean;
  errors: string[];
  results: CaseResult[];
}

export function aggregateResults(
  results: CaseResult[],
  caseDefinitions: HarnessCase[]
): AggregateReport {
  const errors: string[] = [];

  // Detect duplicates
  const seen = new Map<string, true>();
  for (const r of results) {
    const key = `${r.id}::${r.platform}`;
    if (seen.has(key)) {
      errors.push(`duplicate result: ${r.id} on ${r.platform}`);
    } else {
      seen.set(key, true);
    }
  }

  // Index results for lookup
  const byKey = new Map<string, CaseResult>();
  for (const r of results) {
    const key = `${r.id}::${r.platform}`;
    if (!byKey.has(key)) {
      byKey.set(key, r);
    }
  }

  // Require each automated case on each of its listed platforms
  for (const def of caseDefinitions) {
    if (def.status !== "automated") continue;
    for (const platform of def.platforms) {
      const key = `${def.id}::${platform}`;
      const r = byKey.get(key);
      if (!r) {
        errors.push(`missing required result: ${def.id} on ${platform}`);
      } else if (r.status === "failed") {
        errors.push(
          `required result ${def.id} on ${platform} failed (${r.failureKind ?? "unknown"})`
        );
      } else if (r.status === "skipped") {
        errors.push(`required result ${def.id} on ${platform} was skipped`);
      }
    }
  }

  const sorted = [...results].sort((a, b) => {
    const idCmp = a.id.localeCompare(b.id);
    return idCmp !== 0 ? idCmp : a.platform.localeCompare(b.platform);
  });

  return { ok: errors.length === 0, errors, results: sorted };
}

async function collectResults(
  dir: string,
  out: CaseResult[]
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectResults(fullPath, out);
    } else if (entry.isFile() && entry.name === "result.json") {
      try {
        const raw = await readFile(fullPath, "utf8");
        const parsed = JSON.parse(raw) as CaseResult;
        out.push(parsed);
      } catch (err) {
        out.push({
          id: "<malformed>",
          platform: "linux",
          status: "failed",
          durationMs: 0,
          failureKind: "catalogue",
          message: `malformed result.json at ${fullPath}: ${String(err)}`,
          artifactDir: dir,
        });
      }
    }
  }
}

function buildSummaryMd(report: AggregateReport): string {
  const lines: string[] = [
    "# Aggregate Summary",
    "",
    `**Status:** ${report.ok ? "✅ PASS" : "❌ FAIL"}`,
    `**Total results:** ${report.results.length}`,
    "",
  ];
  if (report.errors.length > 0) {
    lines.push("## Errors", "");
    for (const e of report.errors) lines.push(`- ${e}`);
    lines.push("");
  }
  lines.push("## Results", "");
  for (const r of report.results) {
    const badge =
      r.status === "passed" ? "✅" : r.status === "failed" ? "❌" : "⏭";
    lines.push(`- ${badge} \`${r.id}\` on \`${r.platform}\` (${r.durationMs}ms)`);
  }
  return lines.join("\n") + "\n";
}

export async function runAggregateCli(args: string[]): Promise<number> {
  if (args.length !== 3) {
    console.error(
      "Usage: aggregate <results-dir> <manual-tests-dir> <suite>"
    );
    return 2;
  }

  const [resultsDir, manualTestsDir, suite] = args;

  let allCases: HarnessCase[];
  try {
    allCases = await loadHarnessCases(manualTestsDir);
  } catch (err) {
    console.error(`Failed to load cases from ${manualTestsDir}: ${String(err)}`);
    return 2;
  }

  const suiteCases = allCases.filter((c) => c.suite === suite);

  const results: CaseResult[] = [];
  await collectResults(resultsDir, results);

  const report = aggregateResults(results, suiteCases);

  await writeFile(
    join(resultsDir, "summary.json"),
    JSON.stringify(report, null, 2) + "\n"
  );
  const md = buildSummaryMd(report);
  await writeFile(join(resultsDir, "summary.md"), md);

  process.stdout.write(md);
  return report.ok ? 0 : 1;
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runAggregateCli(process.argv.slice(2)).then((code) =>
    process.exit(code)
  );
}
