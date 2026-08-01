import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HarnessError, type HarnessPlatform, type PlatformExpectation } from "./types.js";

export type DarId =
  | "DAR-01"
  | "DAR-02"
  | "DAR-03"
  | "DAR-04"
  | "DAR-05"
  | "DAR-06"
  | "DAR-07"
  | "DAR-08"
  | "DAR-09"
  | "DAR-10";

export interface ScenarioDefinition {
  darId: DarId;
  title: string;
  manualPath: string;
  manualHeading: string;
  suite: "dar";
  timeoutMs: number;
  expectations: Record<HarnessPlatform, PlatformExpectation>;
}

export const SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [
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
    },
  },
  {
    darId: "DAR-02",
    title: "Headless session dashboard replay and live output",
    manualPath: "docs/manual-tests/daemon-actor-rewrite.md",
    manualHeading: "## DAR-02 — Headless session and dashboard attach / replay",
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
    },
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
    },
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
          "local-restore-resizes-to-local-grid",
          "local-restore-complete-authoritative-repaint",
          "same-size-browser-control-jiggle",
          "same-size-complete-repaint",
        ],
      },
    },
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
    },
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
    },
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
    },
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
    },
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
    },
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
    },
  },
];

export async function validateScenarioDefinitions(
  rootDir: string,
  definitions: readonly ScenarioDefinition[] = SCENARIO_DEFINITIONS
): Promise<void> {
  const seenIds = new Set<DarId>();
  const manualContents = new Map<string, string>();

  for (const definition of definitions) {
    if (seenIds.has(definition.darId)) {
      throw new HarnessError(
        "prerequisite",
        `Duplicate DAR id: ${definition.darId}`
      );
    }
    seenIds.add(definition.darId);

    let contents = manualContents.get(definition.manualPath);
    if (contents === undefined) {
      contents = await readFile(resolve(rootDir, definition.manualPath), "utf8");
      manualContents.set(definition.manualPath, contents);
    }

    const manualLines = contents.split(/\r?\n/);

    if (!manualLines.includes(definition.manualHeading)) {
      throw new HarnessError(
        "prerequisite",
        `Missing manual heading "${definition.manualHeading}" in ${definition.manualPath} for ${definition.darId}`
      );
    }
  }
}
