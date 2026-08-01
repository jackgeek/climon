import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SCENARIO_DEFINITIONS,
  validateScenarioDefinitions,
} from "../src/scenario-registry.js";
import type { ScenarioDefinition } from "../src/scenario-registry.js";
import type {
  HarnessPlatform,
  PlatformExpectation,
} from "../src/types.js";

function makeWorkspace(name: string): string {
  const workspace = resolve(
    import.meta.dir,
    "..",
    ".test-workspace",
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

describe("SCENARIO_DEFINITIONS", () => {
  test("registers DAR-01 through DAR-10 in order with typed per-platform expectations", () => {
    const expectedDefinitions: readonly ScenarioDefinition[] = [
      {
        darId: "DAR-01",
        title: "Attached shell input, output, and terminal restoration",
        manualPath: "docs/manual-tests/daemon-actor-rewrite.md",
        manualHeading:
          "## DAR-01 — Attached shell: input, output, and raw-mode restoration",
        suite: "dar",
        timeoutMs: 180_000,
        expectations: {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: {
            expected: "known-failure",
            reason:
              "The latest Windows manual run could not verify attached console fidelity or mode restoration.",
            tracking: "docs/manual-tests/results/windows.md",
            reviewAfter: "2026-08-31",
            allowedFailedSubchecks: [
              "attached-startup",
              "text-input-output",
              "control-and-key-input",
              "mouse-input",
              "alternate-screen-render",
              "resize-repaint",
              "terminal-mode-restoration",
            ],
          },
        } satisfies Record<HarnessPlatform, PlatformExpectation>,
      },
      {
        darId: "DAR-02",
        title: "Headless session dashboard replay and live output",
        manualPath: "docs/manual-tests/daemon-actor-rewrite.md",
        manualHeading:
          "## DAR-02 — Headless session and dashboard attach / replay",
        suite: "dar",
        timeoutMs: 180_000,
        expectations: {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: {
            expected: "partial",
            reason:
              "The latest Windows manual run showed the session but did not verify rendered replay plus continued live output.",
            tracking: "docs/manual-tests/results/windows.md",
            reviewAfter: "2026-08-31",
            allowedFailedSubchecks: [
              "replay-visible",
              "browser-input",
              "live-output",
            ],
          },
        } satisfies Record<HarnessPlatform, PlatformExpectation>,
      },
      {
        darId: "DAR-03",
        title: "Dashboard and PWA take-control with local Space reclaim",
        manualPath: "docs/manual-tests/daemon-actor-rewrite.md",
        manualHeading:
          "## DAR-03 — Dashboard / PWA take-control and local Space reclaim",
        suite: "dar",
        timeoutMs: 180_000,
        expectations: {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: {
            expected: "known-failure",
            reason:
              "The latest Windows manual run could not verify local displacement, Space reclaim, or PWA control from a real Windows console.",
            tracking: "docs/manual-tests/results/windows.md",
            reviewAfter: "2026-08-31",
            allowedFailedSubchecks: [
              "local-starts-as-controller",
              "displaced-local-non-space-suppressed",
              "simulated-pwa-newest-controller",
              "local-space-reclaims-control",
              "local-resize-authoritative",
            ],
          },
        } satisfies Record<HarnessPlatform, PlatformExpectation>,
      },
      {
        darId: "DAR-04",
        title: "Local restore and same-size repaint jiggle",
        manualPath: "docs/manual-tests/daemon-actor-rewrite.md",
        manualHeading: "## DAR-04 — Local restore and same-size repaint jiggle",
        suite: "dar",
        timeoutMs: 180_000,
        expectations: {
          linux: {
            expected: "partial",
            reason:
              "The latest Linux manual run verified repaint flow with Vim but did not cover the required frame-caching same-size repaint case.",
            tracking: "docs/manual-tests/results/linux.md",
            reviewAfter: "2026-08-31",
            allowedFailedSubchecks: ["same-size-complete-repaint"],
          },
          macos: { expected: "pass" },
          windows: {
            expected: "known-failure",
            reason:
              "The latest Windows manual run could not attach the full-screen console workflow needed for restore and same-size repaint checks.",
            tracking: "docs/manual-tests/results/windows.md",
            reviewAfter: "2026-08-31",
            allowedFailedSubchecks: [
              "larger-browser-displaces-local",
              "local-restore-jiggles-both-dimensions",
              "local-restore-complete-authoritative-repaint",
              "same-size-browser-control-jiggle",
              "same-size-complete-repaint",
            ],
          },
        } satisfies Record<HarnessPlatform, PlatformExpectation>,
      },
      {
        darId: "DAR-05",
        title: "Attention flag, acknowledgement, and resize stickiness",
        manualPath: "docs/manual-tests/daemon-actor-rewrite.md",
        manualHeading:
          "## DAR-05 — Attention flag, acknowledgement, and resize stickiness",
        suite: "dar",
        timeoutMs: 180_000,
        expectations: {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: {
            expected: "partial",
            reason:
              "The latest Windows manual run only verified initial attention and acknowledgement; body-change reset and resize stickiness remain blocked.",
            tracking: "docs/manual-tests/results/windows.md",
            reviewAfter: "2026-08-31",
            allowedFailedSubchecks: [
              "body-change-reset",
              "reflag-after-body-change",
              "resize-stickiness",
              "stale-token-rejection",
              "second-token-acknowledgement",
            ],
          },
        } satisfies Record<HarnessPlatform, PlatformExpectation>,
      },
      {
        darId: "DAR-06",
        title: "Terminal title and progress capture",
        manualPath: "docs/manual-tests/daemon-actor-rewrite.md",
        manualHeading: "## DAR-06 — Terminal title and progress capture",
        suite: "dar",
        timeoutMs: 180_000,
        expectations: {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: {
            expected: "known-failure",
            reason:
              "The latest Windows manual run observed partial OSC output but could not isolate title and progress behavior from the broader ConPTY lifecycle failure.",
            tracking: "docs/manual-tests/results/windows.md",
            reviewAfter: "2026-08-31",
            allowedFailedSubchecks: [
              "osc-2-title",
              "progress-clear",
              "progress-indeterminate",
              "progress-error",
              "progress-warning",
              "raw-sequence-passthrough",
            ],
          },
        } satisfies Record<HarnessPlatform, PlatformExpectation>,
      },
      {
        darId: "DAR-07",
        title: "Fast exit, failed exit, final scrollback, and socket cleanup",
        manualPath: "docs/manual-tests/daemon-actor-rewrite.md",
        manualHeading:
          "## DAR-07 — Fast exit, failed exit, final scrollback, and socket cleanup",
        suite: "dar",
        timeoutMs: 180_000,
        expectations: {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: {
            expected: "known-failure",
            reason:
              "The latest Windows manual run did not observe process exit finalization after fast-success or failed-exit commands.",
            tracking: "docs/manual-tests/results/windows.md",
            reviewAfter: "2026-08-31",
            allowedFailedSubchecks: [
              "success-finalization",
              "success-socket-cleanup",
              "failure-finalization",
              "failure-socket-cleanup",
            ],
          },
        } satisfies Record<HarnessPlatform, PlatformExpectation>,
      },
      {
        darId: "DAR-08",
        title: "Slow and disconnecting viewer isolation",
        manualPath: "docs/manual-tests/daemon-actor-rewrite.md",
        manualHeading: "## DAR-08 — Slow / disconnecting viewer isolation",
        suite: "dar",
        timeoutMs: 180_000,
        expectations: {
          linux: {
            expected: "known-failure",
            reason:
              "The latest Linux manual run found a reproducible crash under concurrent viewers on high-volume output.",
            tracking: "docs/manual-tests/results/linux.md",
            reviewAfter: "2026-08-31",
            allowedFailedSubchecks: [
              "disconnecting-viewer-isolated",
              "healthy-viewer-stays-live",
              "session-finalizes-after-flood",
              "daemon-remains-panic-free",
            ],
          },
          macos: { expected: "pass" },
          windows: {
            expected: "known-failure",
            reason:
              "The latest Windows manual run did not exercise streamed output or viewer backpressure isolation.",
            tracking: "docs/manual-tests/results/windows.md",
            reviewAfter: "2026-08-31",
            allowedFailedSubchecks: [
              "healthy-viewer-receives-initial-stream",
              "disconnecting-viewer-isolated",
              "healthy-viewer-stays-live",
              "session-finalizes-after-flood",
              "daemon-remains-panic-free",
            ],
          },
        } satisfies Record<HarnessPlatform, PlatformExpectation>,
      },
      {
        darId: "DAR-09",
        title: "SIGINT, SIGTERM, and Windows process termination",
        manualPath: "docs/manual-tests/daemon-actor-rewrite.md",
        manualHeading:
          "## DAR-09 — SIGINT / SIGTERM and Windows process termination",
        suite: "dar",
        timeoutMs: 180_000,
        expectations: {
          linux: {
            expected: "partial",
            reason:
              "The latest Linux manual run did not capture repeated-signal idempotency or directly isolate the resize path.",
            tracking: "docs/manual-tests/results/linux.md",
            reviewAfter: "2026-08-31",
            allowedFailedSubchecks: [
              "repeated-signal-idempotency",
              "attached-resize-path",
            ],
          },
          macos: { expected: "pass" },
          windows: {
            expected: "partial",
            reason:
              "The latest Windows manual run verified forced host termination only; interactive resize polling remains blocked.",
            tracking: "docs/manual-tests/results/windows.md",
            reviewAfter: "2026-08-31",
            allowedFailedSubchecks: ["windows-console-resize-poller"],
          },
        } satisfies Record<HarnessPlatform, PlatformExpectation>,
      },
      {
        darId: "DAR-10",
        title: "Actor-to-legacy rollback via CLIMON_SESSION_ENGINE",
        manualPath: "docs/manual-tests/daemon-actor-rewrite.md",
        manualHeading:
          "## DAR-10 — Actor-to-legacy rollback via `CLIMON_SESSION_ENGINE`",
        suite: "dar",
        timeoutMs: 180_000,
        expectations: {
          linux: { expected: "pass" },
          macos: { expected: "pass" },
          windows: {
            expected: "partial",
            reason:
              "The latest Windows manual run verified invalid-engine diagnostics only; actor and legacy interactive parity remains blocked by the non-interactive ConPTY environment.",
            tracking: "docs/manual-tests/results/windows.md",
            reviewAfter: "2026-08-31",
            allowedFailedSubchecks: [
              "default-legacy-engine",
              "explicit-actor-engine",
              "explicit-legacy-rollback",
              "external-parity",
            ],
          },
        } satisfies Record<HarnessPlatform, PlatformExpectation>,
      },
    ];

    expect(SCENARIO_DEFINITIONS.map(({ darId }) => darId)).toEqual([
      "DAR-01",
      "DAR-02",
      "DAR-03",
      "DAR-04",
      "DAR-05",
      "DAR-06",
      "DAR-07",
      "DAR-08",
      "DAR-09",
      "DAR-10",
    ]);
    expect(SCENARIO_DEFINITIONS).toEqual(expectedDefinitions);
  });
});

describe("validateScenarioDefinitions", () => {
  test("succeeds against the repository root", async () => {
    const repositoryRoot = resolve(import.meta.dir, "..", "..");

    await expect(
      validateScenarioDefinitions(repositoryRoot)
    ).resolves.toBeUndefined();
  });

  test("rejects when a referenced manual heading is missing", async () => {
    const workspace = makeWorkspace("missing-heading");
    const manualPath = join(
      workspace,
      "docs",
      "manual-tests",
      "daemon-actor-rewrite.md"
    );

    try {
      mkdirSync(join(workspace, "docs", "manual-tests"), { recursive: true });
      writeFileSync(
        manualPath,
        [
          "# Daemon actor rewrite",
          "",
          "## DAR-01 — Attached shell: input, output, and raw-mode restoration",
        ].join("\n")
      );

      await expect(validateScenarioDefinitions(workspace)).rejects.toThrow(
        'Missing manual heading "## DAR-02 — Headless session and dashboard attach / replay" in docs/manual-tests/daemon-actor-rewrite.md for DAR-02'
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects duplicate DAR ids", async () => {
    const duplicateDefinitions = [
      SCENARIO_DEFINITIONS[0],
      SCENARIO_DEFINITIONS[0],
    ];

    await expect(
      validateScenarioDefinitions(process.cwd(), duplicateDefinitions)
    ).rejects.toThrow("Duplicate DAR id: DAR-01");
  });
});
