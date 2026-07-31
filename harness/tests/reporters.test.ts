import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createResultsReport,
  parseResultsReport,
  writeJsonReport,
  type ResultsReport,
} from "../src/reporters/json.js";
import { renderJUnitReport } from "../src/reporters/junit.js";
import { renderMarkdownReport } from "../src/reporters/markdown.js";
import type { CaseResult, HarnessPlatform, PlatformExpectation } from "../src/types.js";

const FIXED_NOW = "2026-07-31T21:27:33.660Z";

function makeWorkspace(name: string): string {
  const workspace = resolve(
    import.meta.dir,
    "..",
    ".test-workspace",
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  rmSync(workspace, { recursive: true, force: true });
  return workspace;
}

function createResult(
  platform: HarnessPlatform,
  darId: string,
  title: string,
  expectation: PlatformExpectation,
  overrides: Partial<CaseResult> = {}
): CaseResult & { expectation: PlatformExpectation } {
  return {
    artifactDir: `/artifacts/${platform}/cases/${darId}`,
    blocking: false,
    darId,
    durationMs: 0,
    expectation,
    failedSubchecks: [],
    platform,
    status: "passed",
    subchecks: [],
    title,
    ...overrides,
  };
}

function sampleReport(): ResultsReport {
  return createResultsReport("rev-123", FIXED_NOW, [
    createResult("windows", "DAR-02", "Headless session dashboard replay and live output", {
      expected: "unsupported",
      reason: "Windows coverage is intentionally skipped in this unit test.",
    }, {
      message: "Unsupported on this platform: Windows coverage is intentionally skipped in this unit test.",
      status: "unsupported",
    }),
    createResult("macos", "DAR-01", "Attached shell input, output, and terminal restoration", {
      expected: "known-failure",
      reason: "Attached shell fidelity is still under investigation on macOS.",
      tracking: "docs/manual-tests/results/macos.md",
      reviewAfter: "2026-08-31",
      allowedFailedSubchecks: ["text-input-output"],
    }, {
      failedSubchecks: ["text-input-output"],
      message:
        "Expected known failure: Attached shell fidelity is still under investigation on macOS. (tracking: docs/manual-tests/results/macos.md; review after: 2026-08-31)",
      status: "expected-failure",
      subchecks: [
        {
          durationMs: 12,
          message: "echo text differed",
          name: "text-input-output",
          status: "failed",
        },
      ],
    }),
    createResult("linux", "DAR-02", "Headless session dashboard replay and live output", {
      expected: "partial",
      reason: "Replay is still flaky on Linux in this unit test.",
      tracking: "docs/manual-tests/results/linux.md",
      reviewAfter: "2026-08-31",
      allowedFailedSubchecks: ["replay-visible"],
    }, {
      blocking: true,
      durationMs: 15,
      failedSubchecks: ["replay-visible"],
      message: "Replay broke",
      status: "unexpected-failure",
      subchecks: [
        {
          durationMs: 15,
          message: "Replay broke",
          name: "replay-visible",
          status: "failed",
        },
      ],
    }),
    createResult("linux", "DAR-01", "Attached shell input, output, and terminal restoration", {
      expected: "pass",
    }, {
      durationMs: 3,
      subchecks: [
        {
          durationMs: 3,
          name: "attached-startup",
          status: "passed",
        },
      ],
    }),
    createResult("macos", "DAR-02", "Headless session dashboard replay and live output", {
      expected: "partial",
      reason: "Replay is still flaky on macOS in this unit test.",
      tracking: "docs/manual-tests/results/macos.md",
      reviewAfter: "2026-09-15",
      allowedFailedSubchecks: ["replay-visible"],
    }, {
      durationMs: 9,
      failedSubchecks: ["replay-visible"],
      message:
        "Expected partial result: Replay is still flaky on macOS in this unit test. (tracking: docs/manual-tests/results/macos.md; review after: 2026-09-15)",
      status: "expected-partial",
      subchecks: [
        {
          durationMs: 9,
          message: "Replay was intentionally allowed to fail.",
          name: "replay-visible",
          status: "failed",
        },
      ],
    }),
  ]);
}

describe("reporters", () => {
  test("writes deterministic sorted JSON reports and creates parent directories", async () => {
    const workspace = makeWorkspace("reporter-json");

    try {
      await mkdir(workspace, { recursive: true });
      const report = sampleReport();
      const outputPath = join(workspace, "nested", "reports", "results.json");

      await writeJsonReport(outputPath, report);

      const output = readFileSync(outputPath, "utf8");
      expect(output).toBe(`{
  "generatedAt": "2026-07-31T21:27:33.660Z",
  "results": [
    {
      "artifactDir": "/artifacts/linux/cases/DAR-01",
      "blocking": false,
      "darId": "DAR-01",
      "durationMs": 3,
      "expectation": {
        "expected": "pass"
      },
      "failedSubchecks": [],
      "platform": "linux",
      "status": "passed",
      "subchecks": [
        {
          "durationMs": 3,
          "name": "attached-startup",
          "status": "passed"
        }
      ],
      "title": "Attached shell input, output, and terminal restoration"
    },
    {
      "artifactDir": "/artifacts/linux/cases/DAR-02",
      "blocking": true,
      "darId": "DAR-02",
      "durationMs": 15,
      "expectation": {
        "allowedFailedSubchecks": [
          "replay-visible"
        ],
        "expected": "partial",
        "reason": "Replay is still flaky on Linux in this unit test.",
        "reviewAfter": "2026-08-31",
        "tracking": "docs/manual-tests/results/linux.md"
      },
      "failedSubchecks": [
        "replay-visible"
      ],
      "message": "Replay broke",
      "platform": "linux",
      "status": "unexpected-failure",
      "subchecks": [
        {
          "durationMs": 15,
          "message": "Replay broke",
          "name": "replay-visible",
          "status": "failed"
        }
      ],
      "title": "Headless session dashboard replay and live output"
    },
    {
      "artifactDir": "/artifacts/macos/cases/DAR-01",
      "blocking": false,
      "darId": "DAR-01",
      "durationMs": 0,
      "expectation": {
        "allowedFailedSubchecks": [
          "text-input-output"
        ],
        "expected": "known-failure",
        "reason": "Attached shell fidelity is still under investigation on macOS.",
        "reviewAfter": "2026-08-31",
        "tracking": "docs/manual-tests/results/macos.md"
      },
      "failedSubchecks": [
        "text-input-output"
      ],
      "message": "Expected known failure: Attached shell fidelity is still under investigation on macOS. (tracking: docs/manual-tests/results/macos.md; review after: 2026-08-31)",
      "platform": "macos",
      "status": "expected-failure",
      "subchecks": [
        {
          "durationMs": 12,
          "message": "echo text differed",
          "name": "text-input-output",
          "status": "failed"
        }
      ],
      "title": "Attached shell input, output, and terminal restoration"
    },
    {
      "artifactDir": "/artifacts/macos/cases/DAR-02",
      "blocking": false,
      "darId": "DAR-02",
      "durationMs": 9,
      "expectation": {
        "allowedFailedSubchecks": [
          "replay-visible"
        ],
        "expected": "partial",
        "reason": "Replay is still flaky on macOS in this unit test.",
        "reviewAfter": "2026-09-15",
        "tracking": "docs/manual-tests/results/macos.md"
      },
      "failedSubchecks": [
        "replay-visible"
      ],
      "message": "Expected partial result: Replay is still flaky on macOS in this unit test. (tracking: docs/manual-tests/results/macos.md; review after: 2026-09-15)",
      "platform": "macos",
      "status": "expected-partial",
      "subchecks": [
        {
          "durationMs": 9,
          "message": "Replay was intentionally allowed to fail.",
          "name": "replay-visible",
          "status": "failed"
        }
      ],
      "title": "Headless session dashboard replay and live output"
    },
    {
      "artifactDir": "/artifacts/windows/cases/DAR-02",
      "blocking": false,
      "darId": "DAR-02",
      "durationMs": 0,
      "expectation": {
        "expected": "unsupported",
        "reason": "Windows coverage is intentionally skipped in this unit test."
      },
      "failedSubchecks": [],
      "message": "Unsupported on this platform: Windows coverage is intentionally skipped in this unit test.",
      "platform": "windows",
      "status": "unsupported",
      "subchecks": [],
      "title": "Headless session dashboard replay and live output"
    }
  ],
  "revision": "rev-123"
}
`);
      expect(parseResultsReport(output, outputPath)).toEqual(report);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects duplicate case rows while parsing report JSON", () => {
    expect(() =>
      parseResultsReport(
        JSON.stringify({
          revision: "rev-123",
          generatedAt: FIXED_NOW,
          results: [
            createResult("linux", "DAR-01", "Attached shell input, output, and terminal restoration", {
              expected: "pass",
            }),
            createResult("linux", "DAR-01", "Attached shell input, output, and terminal restoration", {
              expected: "pass",
            }),
            createResult("linux", "DAR-02", "Headless session dashboard replay and live output", {
              expected: "pass",
            }),
          ],
        }),
        "/reports/results.json"
      )
    ).toThrow("Malformed report JSON in /reports/results.json: duplicate case row for linux DAR-01");
  });

  test("renders markdown summaries with expectation governance details", () => {
    expect(renderMarkdownReport(sampleReport())).toBe(`# DAR harness summary

- revision: rev-123
- generatedAt: 2026-07-31T21:27:33.660Z
- blocking: yes

| Platform | DAR | Title | Status | Blocking | Expected | Failed subchecks |
| --- | --- | --- | --- | --- | --- | --- |
| linux | DAR-01 | Attached shell input, output, and terminal restoration | passed | no | pass | - |
| linux | DAR-02 | Headless session dashboard replay and live output | unexpected-failure | yes | partial | replay-visible |
| macos | DAR-01 | Attached shell input, output, and terminal restoration | expected-failure | no | known-failure | text-input-output |
| macos | DAR-02 | Headless session dashboard replay and live output | expected-partial | no | partial | replay-visible |
| windows | DAR-02 | Headless session dashboard replay and live output | unsupported | no | unsupported | - |

## linux / DAR-01 — Attached shell input, output, and terminal restoration
- expected: pass
- actual status: passed
- actual failed: -
- blocking: no
- message: -

## linux / DAR-02 — Headless session dashboard replay and live output
- expected: partial
- actual status: unexpected-failure
- actual failed: replay-visible
- blocking: yes
- reason: Replay is still flaky on Linux in this unit test.
- tracking: docs/manual-tests/results/linux.md
- reviewAfter: 2026-08-31
- allowedFailed: replay-visible
- message: Replay broke

## macos / DAR-01 — Attached shell input, output, and terminal restoration
- expected: known-failure
- actual status: expected-failure
- actual failed: text-input-output
- blocking: no
- reason: Attached shell fidelity is still under investigation on macOS.
- tracking: docs/manual-tests/results/macos.md
- reviewAfter: 2026-08-31
- allowedFailed: text-input-output
- message: Expected known failure: Attached shell fidelity is still under investigation on macOS. (tracking: docs/manual-tests/results/macos.md; review after: 2026-08-31)

## macos / DAR-02 — Headless session dashboard replay and live output
- expected: partial
- actual status: expected-partial
- actual failed: replay-visible
- blocking: no
- reason: Replay is still flaky on macOS in this unit test.
- tracking: docs/manual-tests/results/macos.md
- reviewAfter: 2026-09-15
- allowedFailed: replay-visible
- message: Expected partial result: Replay is still flaky on macOS in this unit test. (tracking: docs/manual-tests/results/macos.md; review after: 2026-09-15)

## windows / DAR-02 — Headless session dashboard replay and live output
- expected: unsupported
- actual status: unsupported
- actual failed: -
- blocking: no
- reason: Windows coverage is intentionally skipped in this unit test.
- message: Unsupported on this platform: Windows coverage is intentionally skipped in this unit test.
`);
  });

  test("renders valid JUnit XML with pass skip and failure semantics", () => {
    expect(renderJUnitReport(sampleReport())).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="dar-harness" tests="5" failures="1" skipped="3" time="0.027">
  <properties>
    <property name="revision" value="rev-123"/>
    <property name="generatedAt" value="2026-07-31T21:27:33.660Z"/>
  </properties>
  <testcase classname="linux.DAR-01" name="DAR-01 Attached shell input, output, and terminal restoration" time="0.003">
    <system-out>{&quot;artifactDir&quot;:&quot;/artifacts/linux/cases/DAR-01&quot;,&quot;failedSubchecks&quot;:[],&quot;message&quot;:null,&quot;subchecks&quot;:[{&quot;durationMs&quot;:3,&quot;name&quot;:&quot;attached-startup&quot;,&quot;status&quot;:&quot;passed&quot;}]}</system-out>
  </testcase>
  <testcase classname="linux.DAR-02" name="DAR-02 Headless session dashboard replay and live output" time="0.015">
    <failure message="unexpected-failure">Replay broke</failure>
    <system-out>{&quot;artifactDir&quot;:&quot;/artifacts/linux/cases/DAR-02&quot;,&quot;failedSubchecks&quot;:[&quot;replay-visible&quot;],&quot;message&quot;:&quot;Replay broke&quot;,&quot;subchecks&quot;:[{&quot;durationMs&quot;:15,&quot;message&quot;:&quot;Replay broke&quot;,&quot;name&quot;:&quot;replay-visible&quot;,&quot;status&quot;:&quot;failed&quot;}]}</system-out>
  </testcase>
  <testcase classname="macos.DAR-01" name="DAR-01 Attached shell input, output, and terminal restoration" time="0.000">
    <skipped message="expected-failure">Expected known failure: Attached shell fidelity is still under investigation on macOS. (tracking: docs/manual-tests/results/macos.md; review after: 2026-08-31)</skipped>
    <system-out>{&quot;artifactDir&quot;:&quot;/artifacts/macos/cases/DAR-01&quot;,&quot;failedSubchecks&quot;:[&quot;text-input-output&quot;],&quot;message&quot;:&quot;Expected known failure: Attached shell fidelity is still under investigation on macOS. (tracking: docs/manual-tests/results/macos.md; review after: 2026-08-31)&quot;,&quot;subchecks&quot;:[{&quot;durationMs&quot;:12,&quot;message&quot;:&quot;echo text differed&quot;,&quot;name&quot;:&quot;text-input-output&quot;,&quot;status&quot;:&quot;failed&quot;}]}</system-out>
  </testcase>
  <testcase classname="macos.DAR-02" name="DAR-02 Headless session dashboard replay and live output" time="0.009">
    <skipped message="expected-partial">Expected partial result: Replay is still flaky on macOS in this unit test. (tracking: docs/manual-tests/results/macos.md; review after: 2026-09-15)</skipped>
    <system-out>{&quot;artifactDir&quot;:&quot;/artifacts/macos/cases/DAR-02&quot;,&quot;failedSubchecks&quot;:[&quot;replay-visible&quot;],&quot;message&quot;:&quot;Expected partial result: Replay is still flaky on macOS in this unit test. (tracking: docs/manual-tests/results/macos.md; review after: 2026-09-15)&quot;,&quot;subchecks&quot;:[{&quot;durationMs&quot;:9,&quot;message&quot;:&quot;Replay was intentionally allowed to fail.&quot;,&quot;name&quot;:&quot;replay-visible&quot;,&quot;status&quot;:&quot;failed&quot;}]}</system-out>
  </testcase>
  <testcase classname="windows.DAR-02" name="DAR-02 Headless session dashboard replay and live output" time="0.000">
    <skipped message="unsupported">Unsupported on this platform: Windows coverage is intentionally skipped in this unit test.</skipped>
    <system-out>{&quot;artifactDir&quot;:&quot;/artifacts/windows/cases/DAR-02&quot;,&quot;failedSubchecks&quot;:[],&quot;message&quot;:&quot;Unsupported on this platform: Windows coverage is intentionally skipped in this unit test.&quot;,&quot;subchecks&quot;:[]}</system-out>
  </testcase>
</testsuite>
`);
  });
});
