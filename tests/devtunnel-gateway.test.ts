import { describe, expect, test } from "bun:test";
import { createDevtunnelGateway, type Runner, type RunResult } from "../src/devtunnel/gateway.js";
import { DevtunnelError, type DevtunnelFailure } from "../src/devtunnel/types.js";
import { DevtunnelRetryController } from "../src/devtunnel/retry.js";
import { startDevtunnelProcess, type RawDevtunnelProcessHandlers, type RawDevtunnelProcessSpawner } from "../src/devtunnel/process.js";

function runnerFrom(resultForArgs: (args: string[]) => RunResult | Promise<RunResult>): Runner {
  return async (_cmd: string, args: string[]) => resultForArgs(args);
}

describe("DevtunnelGateway", () => {
  test("detect reports cli_missing health when the CLI cannot spawn", async () => {
    const gateway = createDevtunnelGateway({
      runner: runnerFrom(() => ({ status: 127, stdout: "", stderr: "spawn failed", spawnError: "ENOENT" }))
    });

    const health = await gateway.detect();

    expect(health.available).toBe(false);
    expect(health.authenticated).toBe(false);
    expect(health.lastFailure?.code).toBe("cli_missing");
  });

  test("showUser reports authenticated health from logged-in JSON and not_authenticated otherwise", async () => {
    const loggedIn = createDevtunnelGateway({
      runner: runnerFrom(() => ({
        status: 0,
        stdout: JSON.stringify({ status: "Logged in", username: "user@example.com" }),
        stderr: ""
      }))
    });
    const loggedOut = createDevtunnelGateway({
      runner: runnerFrom(() => ({ status: 0, stdout: JSON.stringify({ status: "Not logged in" }), stderr: "" }))
    });

    expect(await loggedIn.showUser()).toMatchObject({ available: true, authenticated: true });
    const health = await loggedOut.showUser();
    expect(health.available).toBe(true);
    expect(health.authenticated).toBe(false);
    expect(health.lastFailure?.code).toBe("not_authenticated");
  });

  test("createTunnel converts quota stderr into DevtunnelError", async () => {
    const gateway = createDevtunnelGateway({
      runner: runnerFrom(() => ({ status: 1, stdout: "", stderr: "Too many tunnels exist for this account" }))
    });

    let failure: DevtunnelFailure | undefined;
    try {
      await gateway.createTunnel({ id: "climon-test" });
    } catch (err) {
      expect(err).toBeInstanceOf(DevtunnelError);
      failure = (err as DevtunnelError).failure;
    }

    expect(failure?.code).toBe("tunnel_quota_exhausted");
  });

  test("spawnHost captures output and classifies an early non-zero exit", () => {
    let spawnHandlers: RawDevtunnelProcessHandlers | undefined;
    const stdout: string[] = [];
    const stderr: string[] = [];
    let exitFailure: DevtunnelFailure | undefined;
    const rawSpawner: RawDevtunnelProcessSpawner = (_cmd, _args, handlers) => {
      spawnHandlers = handlers;
      return { stop: () => {}, isAlive: () => true };
    };
    const gateway = createDevtunnelGateway({
      processSpawner: (cmd, args, handlers) => startDevtunnelProcess(cmd, args, rawSpawner, handlers),
      processHandlers: {
        onStdout: (text) => stdout.push(text),
        onStderr: (text) => stderr.push(text),
        onExit: (failure) => {
          exitFailure = failure;
        }
      }
    });

    gateway.spawnHost("climon-test");
    spawnHandlers?.onStdout("starting\n");
    spawnHandlers?.onStderr("service unavailable\n");
    spawnHandlers?.onExit({ status: 1, stdout: stdout.join(""), stderr: stderr.join("") });

    expect(stdout.join("")).toContain("starting");
    expect(stderr.join("")).toContain("service unavailable");
    expect(exitFailure?.code).toBe("service_unavailable");
  });

  test("sanitizes technical detail before failures leave the gateway", async () => {
    const gateway = createDevtunnelGateway({
      runner: runnerFrom(() => ({
        status: 1,
        stdout: "",
        stderr: "not authenticated for user@example.com at https://secret.example.com/tunnel"
      }))
    });

    let detail = "";
    try {
      await gateway.createTunnel({ id: "climon-test" });
    } catch (err) {
      detail = (err as DevtunnelError).failure.technicalDetail;
    }

    expect(detail).not.toContain("user@example.com");
    expect(detail).not.toContain("https://secret.example.com/tunnel");
    expect(detail).toContain("<email>");
    expect(detail).toContain("<url>");
  });
});

describe("DevtunnelRetryController", () => {
  test("actionable failures pause retry", () => {
    const controller = new DevtunnelRetryController(() => 0, () => 0.5);
    const state = controller.fail({
      code: "not_authenticated",
      operation: "show-user",
      summary: "auth required",
      remediation: "login",
      technicalDetail: "not logged in",
      occurredAt: new Date(0).toISOString(),
      retryClass: "actionable",
      retryable: false
    });

    expect(state).toEqual({ attempt: 0, paused: true });
  });

  test("transient failures schedule exponential delays capped at 30000", () => {
    const controller = new DevtunnelRetryController(() => 1_000_000, () => 0.5);
    const failure: DevtunnelFailure = {
      code: "service_unavailable",
      operation: "host-tunnel",
      summary: "service down",
      remediation: "retry",
      technicalDetail: "503",
      occurredAt: new Date(0).toISOString(),
      retryClass: "transient",
      retryable: true
    };

    const delays = Array.from({ length: 7 }, () => {
      const state = controller.fail(failure);
      return Date.parse(state.nextRetryAt!) - 1_000_000;
    });

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  test("success resets attempt count", () => {
    const controller = new DevtunnelRetryController(() => 0, () => 0.5);
    controller.fail({
      code: "process_exited",
      operation: "host-tunnel",
      summary: "exited",
      remediation: "retry",
      technicalDetail: "exit 1",
      occurredAt: new Date(0).toISOString(),
      retryClass: "transient",
      retryable: true
    });

    expect(controller.success()).toEqual({ attempt: 0, paused: false });
  });
});
