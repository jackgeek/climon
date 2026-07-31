import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProcessLedger, type OwnedProcess } from "../src/process-ledger.js";

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

function readLedgerLines(workspace: string) {
  return readFileSync(join(workspace, "case", "process-ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function ownedProcess(
  values: Omit<OwnedProcess, "wait"> & { exitCode: number | null }
): OwnedProcess {
  return {
    ...values,
    wait: async () => values.exitCode,
  };
}

function controlledProcess(
  values: Omit<OwnedProcess, "wait">
): { process: OwnedProcess; exit(code: number | null): void } {
  let resolveExit!: (code: number | null) => void;
  const exitPromise = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });

  return {
    process: {
      ...values,
      wait: () => exitPromise,
    },
    exit: resolveExit,
  };
}

describe("ProcessLedger", () => {
  test("rejects duplicate PID ownership deterministically", async () => {
    const workspace = makeWorkspace("process-ledger-duplicate");
    const ledger = new ProcessLedger(join(workspace, "case"));
    const process = ownedProcess({
      pid: 41,
      label: "server",
      platform: "linux",
      exitCode: 0,
    });

    try {
      await ledger.register(process);
      const error = await ledger.register(process).catch((caught: unknown) => caught);

      expect(error).toEqual(
        expect.objectContaining({
          name: "HarnessError",
          kind: "prerequisite",
          message: expect.stringContaining("41"),
        })
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("kills Unix owned process groups with a negative PGID and logs register terminate exit", async () => {
    const workspace = makeWorkspace("process-ledger-unix");
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const owned = controlledProcess({
      pid: 123,
      label: "daemon",
      platform: "linux",
      processGroup: 456,
    });
    const ledger = new ProcessLedger(join(workspace, "case"), {
      kill(pid, signal) {
        killCalls.push({ pid, signal });
        owned.exit(0);
      },
    });

    try {
      await ledger.register(owned.process);

      await ledger.terminateAll();
      await ledger.assertNoSurvivors();

      expect(killCalls).toEqual([{ pid: -456, signal: "SIGKILL" }]);
      expect(readLedgerLines(workspace).map((entry) => entry.action)).toEqual([
        "register",
        "terminate",
        "exit",
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("uses taskkill with the exact Windows arguments and shell disabled", async () => {
    const workspace = makeWorkspace("process-ledger-windows");
    const commandCalls: Array<{
      file: string;
      args: string[];
      options: { shell: boolean };
    }> = [];
    const owned = controlledProcess({
      pid: 789,
      label: "fixture",
      platform: "windows",
    });
    const ledger = new ProcessLedger(join(workspace, "case"), {
      runCommand(file, args, options) {
        commandCalls.push({ file, args, options: { shell: options.shell } });
        owned.exit(0);
        return { status: 0 };
      },
    });

    try {
      await ledger.register(owned.process);

      await ledger.terminateAll();

      expect(commandCalls).toEqual([
        {
          file: "taskkill",
          args: ["/PID", "789", "/T", "/F"],
          options: { shell: false },
        },
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("attempts every live process and aggregates termination failures", async () => {
    const workspace = makeWorkspace("process-ledger-aggregate");
    const killCalls: number[] = [];
    const stuck = controlledProcess({
      pid: 100,
      label: "stuck-server",
      platform: "linux",
    });
    const worker = controlledProcess({
      pid: 200,
      label: "worker",
      platform: "linux",
    });
    const ledger = new ProcessLedger(join(workspace, "case"), {
      kill(pid) {
        killCalls.push(pid);
        if (pid === 100) {
          throw new Error("boom");
        }
        worker.exit(0);
      },
    });

    try {
      await ledger.register(stuck.process);
      await ledger.register(worker.process);

      const error = await ledger.terminateAll().catch((caught: unknown) => caught);

      expect(killCalls).toEqual([100, 200]);
      expect(error).toEqual(
        expect.objectContaining({
          name: "HarnessError",
          kind: "cleanup",
          message: expect.stringContaining("100"),
        })
      );
      await expect(ledger.assertNoSurvivors()).rejects.toEqual(
        expect.objectContaining({
          name: "HarnessError",
          kind: "cleanup",
        })
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("marks an already-exited process without sending a termination signal", async () => {
    const workspace = makeWorkspace("process-ledger-already-exited");
    const ledger = new ProcessLedger(join(workspace, "case"), {
      kill() {
        throw new Error("kill should not be called");
      },
    });

    try {
      await ledger.register(
        ownedProcess({
          pid: 300,
          label: "finished-client",
          platform: "linux",
          exitCode: 0,
        })
      );

      await ledger.terminateAll();
      await ledger.assertNoSurvivors();

      expect(readLedgerLines(workspace).map((entry) => entry.action)).toEqual([
        "register",
        "exit",
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
