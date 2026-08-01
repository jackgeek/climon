import { describe, expect, test } from "bun:test";
import {
  PtyDriver,
  type PtyProcessLike,
  type PtySpawnOptions,
  type PtySpawnSpec,
  type ScreenLike,
} from "../src/drivers/pty.js";

class FakeDisposable {
  public disposed = false;

  public dispose(): void {
    this.disposed = true;
  }
}

class FakePty implements PtyProcessLike {
  public readonly pid = 4242;
  public readonly process = "fake-shell";
  public cols: number;
  public rows: number;
  public handleFlowControl = false;
  public readonly writes: Array<string | Buffer> = [];
  public readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  public readonly killCalls: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  public constructor(cols = 80, rows = 24) {
    this.cols = cols;
    this.rows = rows;
  }

  public onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    const disposable = new FakeDisposable();
    return {
      dispose: () => {
        disposable.dispose();
        this.dataListeners.delete(listener);
      },
    };
  }

  public onExit(
    listener: (event: { exitCode: number; signal?: number }) => void
  ): { dispose(): void } {
    this.exitListeners.add(listener);
    const disposable = new FakeDisposable();
    return {
      dispose: () => {
        disposable.dispose();
        this.exitListeners.delete(listener);
      },
    };
  }

  public resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizeCalls.push({ cols, rows });
  }

  public clear(): void {}

  public write(data: string | Buffer): void {
    this.writes.push(data);
  }

  public kill(signal?: string): void {
    this.killCalls.push(signal);
  }

  public pause(): void {}

  public resume(): void {}

  public emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  public emitExit(exitCode: number, signal?: number): void {
    for (const listener of this.exitListeners) {
      listener({ exitCode, signal });
    }
  }

  public dataListenerCount(): number {
    return this.dataListeners.size;
  }

  public exitListenerCount(): number {
    return this.exitListeners.size;
  }
}

class FakeScreen implements ScreenLike {
  public readonly writes: string[] = [];
  public readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  public contentsValue = "";
  public cursorValue = { col: 0, row: 0 };
  public disposed = false;

  public async write(data: string | Uint8Array): Promise<void> {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    this.writes.push(text);
    this.contentsValue += text;
    this.cursorValue = { col: this.cursorValue.col + text.length, row: this.cursorValue.row };
  }

  public resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  public contents(): string {
    return this.contentsValue;
  }

  public cursor(): { col: number; row: number } {
    return this.cursorValue;
  }

  public dispose(): void {
    this.disposed = true;
  }
}

class DeferredScreen implements ScreenLike {
  public readonly operations: string[] = [];
  public readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  public contentsValue = "";
  public cursorValue = { col: 0, row: 0 };
  private readonly pendingWrites: Array<{
    text: string;
    resolve: () => void;
  }> = [];

  public write(data: string | Uint8Array): Promise<void> {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    this.operations.push(`write:start:${text}`);
    return new Promise<void>((resolve) => {
      this.pendingWrites.push({
        text,
        resolve: () => {
          this.operations.push(`write:end:${text}`);
          this.contentsValue += text;
          this.cursorValue = {
            col: this.cursorValue.col + text.length,
            row: this.cursorValue.row,
          };
          resolve();
        },
      });
    });
  }

  public resize(cols: number, rows: number): void {
    this.operations.push(`resize:${cols}x${rows}`);
    this.resizeCalls.push({ cols, rows });
  }

  public releaseNextWrite(): void {
    const next = this.pendingWrites.shift();
    if (!next) {
      throw new Error("No pending write to release");
    }
    next.resolve();
  }

  public contents(): string {
    return this.contentsValue;
  }

  public cursor(): { col: number; row: number } {
    return this.cursorValue;
  }
}

class ManualTimer {
  public nowMs = 1_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  public now = (): number => this.nowMs;

  public setTimeout = (callback: () => void, ms?: number): ReturnType<typeof globalThis.setTimeout> => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + Math.max(0, ms ?? 0), callback });
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  };

  public clearTimeout = (id: ReturnType<typeof globalThis.setTimeout>): void => {
    this.timers.delete(id as unknown as number);
  };

  public async advance(ms: number): Promise<void> {
    this.nowMs += ms;

    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.nowMs)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
      if (due.length === 0) {
        return;
      }

      for (const [id, timer] of due) {
        if (!this.timers.delete(id)) {
          continue;
        }
        timer.callback();
        await Promise.resolve();
      }
    }
  }
}

function futureDeadline(): number {
  return Date.now() + 1_000;
}

async function flushMicrotasks(turns = 4): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

function createDriver(options?: {
  now?: () => number;
  appendText?: (path: string, text: string) => Promise<void>;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}) {
  const screen = new FakeScreen();
  const pty = new FakePty();
  const spawnCalls: Array<{
    file: string;
    args: string[];
    options: PtySpawnOptions;
  }> = [];
  const spec: PtySpawnSpec = {
    file: "bash",
    args: ["-lc", "echo ready"],
    cwd: "/repo",
    env: { TERM: "xterm-256color" },
    cols: 80,
    rows: 24,
    inputPath: "artifacts/input.log",
    outputPath: "artifacts/output.log",
  };
  const driver = PtyDriver.spawn(spec, {
    now: options?.now,
    appendText: options?.appendText,
    setTimeout: options?.setTimeout,
    clearTimeout: options?.clearTimeout,
    createScreen: () => screen,
    spawnPty(file, args, spawnOptions) {
      spawnCalls.push({ file, args, options: spawnOptions });
      return pty;
    },
  });

  return { driver, pty, screen, spec, spawnCalls };
}

describe("PtyDriver", () => {
  test("spawns through the injected node-pty seam with the approved spec", () => {
    const { spawnCalls, spec } = createDriver();

    expect(spawnCalls).toEqual([
      {
        file: spec.file,
        args: spec.args,
        options: {
          name: "xterm-256color",
          cols: spec.cols,
          rows: spec.rows,
          cwd: spec.cwd,
          env: spec.env,
          encoding: "utf8",
        },
      },
    ]);
  });

  test("matches raw markers across chunks", async () => {
    const { driver, pty } = createDriver();

    pty.emitData("he");
    const ready = driver.expectRaw("hello", futureDeadline());
    pty.emitData("llo");

    await expect(ready).resolves.toBeUndefined();
  });

  test("fails raw expectations immediately with timeout diagnostics when the deadline elapsed", async () => {
    const { driver, screen, pty } = createDriver({ now: () => 500 });
    screen.contentsValue = "rendered";
    screen.cursorValue = { col: 7, row: 2 };
    pty.emitData("recent output");

    await expect(driver.expectRaw("missing", 499)).rejects.toMatchObject({
      name: "HarnessError",
      kind: "timeout",
    });

    await expect(driver.expectRaw("missing", 499)).rejects.toThrow(
      'marker "missing"'
    );
    await expect(driver.expectRaw("missing", 499)).rejects.toThrow("recent output");
    await expect(driver.expectRaw("missing", 499)).rejects.toThrow("rendered");
    await expect(driver.expectRaw("missing", 499)).rejects.toThrow("cursor=(7,2)");
  });

  test("reevaluates screen predicates after screen writes", async () => {
    const { driver, pty } = createDriver();

    const pending = driver.expectScreen(
      (screen) => screen.contents().includes("READY"),
      futureDeadline()
    );
    pty.emitData("READY");

    await expect(pending).resolves.toBeUndefined();
  });

  test("applies screen updates only after output artifact writes complete", async () => {
    let releaseArtifactWrite: (() => void) | undefined;
    const { driver, pty, screen } = createDriver({
      appendText(artifactPath) {
        if (artifactPath === "artifacts/output.log") {
          return new Promise<void>((resolve) => {
            releaseArtifactWrite = resolve;
          });
        }

        return Promise.resolve();
      },
    });

    const pending = driver.expectScreen(
      (currentScreen) => currentScreen.contents().includes("READY"),
      futureDeadline()
    );
    pty.emitData("READY");

    await Promise.resolve();
    expect(screen.contents()).toBe("");

    releaseArtifactWrite?.();
    await expect(pending).resolves.toBeUndefined();
    expect(screen.contents()).toContain("READY");
    pty.emitExit(0);
    await expect(driver.waitForExit(futureDeadline())).resolves.toBe(0);
  });

  test("queues screen resize between earlier and later screen updates and reevaluates screen waiters", async () => {
    const screen = new DeferredScreen();
    const pty = new FakePty();
    const driver = PtyDriver.spawn(
      {
        file: "bash",
        args: ["-lc", "echo ready"],
        cwd: "/repo",
        env: { TERM: "xterm-256color" },
        cols: 80,
        rows: 24,
        inputPath: "artifacts/input.log",
        outputPath: "artifacts/output.log",
      },
      {
        appendText: () => Promise.resolve(),
        createScreen: () => screen,
        spawnPty: () => pty,
      }
    );

    let resized = false;
    const resizedWaiter = driver.expectScreen((currentScreen) => {
      if (currentScreen === screen && screen.resizeCalls.length > 0) {
        resized = true;
        return true;
      }
      return false;
    }, futureDeadline());
    const postResizeWriteWaiter = driver.expectScreen(
      (currentScreen) =>
        currentScreen === screen && screen.contents().includes("beforeafter"),
      futureDeadline()
    );

    pty.emitData("before");
    driver.resize(120, 40);
    pty.emitData("after");

    await Promise.resolve();
    await Promise.resolve();

    expect(pty.resizeCalls).toEqual([{ cols: 120, rows: 40 }]);
    expect(screen.resizeCalls).toEqual([]);
    expect(resized).toBe(false);

    screen.releaseNextWrite();
    await expect(resizedWaiter).resolves.toBeUndefined();
    expect(screen.resizeCalls).toEqual([{ cols: 120, rows: 40 }]);

    screen.releaseNextWrite();
    await expect(postResizeWriteWaiter).resolves.toBeUndefined();
    expect(screen.operations).toEqual([
      "write:start:before",
      "write:end:before",
      "resize:120x40",
      "write:start:after",
      "write:end:after",
    ]);
  });

  test("resizes the PTY immediately and queues the screen resize with exact dimensions", async () => {
    const { driver, pty, screen } = createDriver();
    const resized = driver.expectScreen(
      () => screen.resizeCalls.length === 1,
      futureDeadline()
    );

    driver.resize(120, 40);

    expect(pty.resizeCalls).toEqual([{ cols: 120, rows: 40 }]);
    await expect(resized).resolves.toBeUndefined();
    expect(screen.resizeCalls).toEqual([{ cols: 120, rows: 40 }]);
  });

  test("treats resize activity as the start of a quiet-period wait", async () => {
    const timer = new ManualTimer();
    const { driver } = createDriver({
      now: timer.now,
      setTimeout: timer.setTimeout as unknown as typeof globalThis.setTimeout,
      clearTimeout: timer.clearTimeout as unknown as typeof globalThis.clearTimeout,
    });

    await timer.advance(250);
    driver.resize(120, 40);
    await flushMicrotasks();
    const quiet = driver.waitForQuiet(50, timer.now() + 500);
    let settled = false;
    quiet.then(() => {
      settled = true;
    });

    await timer.advance(49);
    expect(settled).toBe(false);

    await timer.advance(1);
    await expect(quiet).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  test("restarts the quiet-period wait when new output arrives", async () => {
    const timer = new ManualTimer();
    const { driver, pty } = createDriver({
      now: timer.now,
      setTimeout: timer.setTimeout as unknown as typeof globalThis.setTimeout,
      clearTimeout: timer.clearTimeout as unknown as typeof globalThis.clearTimeout,
    });
    pty.emitData("before");
    await driver.expectScreen((screen) => screen.contents().includes("before"), futureDeadline());

    const quiet = driver.waitForQuiet(50, timer.now() + 500);
    let settled = false;
    quiet.then(() => {
      settled = true;
    });

    await timer.advance(40);
    expect(settled).toBe(false);
    pty.emitData("after");
    await driver.expectScreen((screen) => screen.contents().includes("beforeafter"), futureDeadline());

    await timer.advance(49);
    expect(settled).toBe(false);

    await timer.advance(1);
    await expect(quiet).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  test("returns the exact exit code for current and future callers", async () => {
    const { driver, pty } = createDriver();

    const first = driver.waitForExit(futureDeadline());
    const second = driver.waitForExit(futureDeadline());
    pty.emitExit(17);

    await expect(first).resolves.toBe(17);
    await expect(second).resolves.toBe(17);
    await expect(driver.waitForExit(futureDeadline())).resolves.toBe(17);
  });

  test("writes ordered input and output evidence without delaying PTY writes", async () => {
    const appendCalls: Array<{ path: string; text: string }> = [];
    const { driver, pty } = createDriver({
      async appendText(path, text) {
        await Promise.resolve();
        appendCalls.push({ path, text });
      },
    });

    driver.writeText("echo");
    driver.writeLine(" ready");
    pty.emitData("out-1");
    pty.emitData("out-2");
    pty.emitExit(0);

    expect(pty.writes).toEqual(["echo", " ready\r"]);
    await expect(driver.waitForExit(futureDeadline())).resolves.toBe(0);
    expect(appendCalls.filter((call) => call.path === "artifacts/input.log")).toEqual([
      { path: "artifacts/input.log", text: "echo" },
      { path: "artifacts/input.log", text: " ready\r" },
    ]);
    expect(appendCalls.filter((call) => call.path === "artifacts/output.log")).toEqual([
      { path: "artifacts/output.log", text: "out-1" },
      { path: "artifacts/output.log", text: "out-2" },
    ]);
  });

  test("kills only the owned PTY and disposes listeners and the screen after exit", async () => {
    const { driver, pty, screen } = createDriver();

    driver.kill();
    expect(pty.killCalls).toEqual([undefined]);
    expect(pty.dataListenerCount()).toBe(1);
    expect(pty.exitListenerCount()).toBe(1);

    pty.emitExit(0);
    await expect(driver.waitForExit(futureDeadline())).resolves.toBe(0);

    expect(screen.disposed).toBe(true);
    expect(pty.dataListenerCount()).toBe(0);
    expect(pty.exitListenerCount()).toBe(0);
  });

  test("still kills the owned PTY after an async evidence failure", async () => {
    const { driver, pty } = createDriver({
      appendText(artifactPath) {
        if (artifactPath !== "artifacts/input.log") {
          return Promise.resolve();
        }
        return Promise.reject(new Error("disk full"));
      },
    });

    driver.writeText("echo");
    await Promise.resolve();
    await Promise.resolve();

    expect(() => driver.kill()).not.toThrow();
    expect(pty.killCalls).toEqual([undefined]);
  });

  test("waits for output evidence to append before resolving raw and screen waiters", async () => {
    let releaseOutputAppend: (() => void) | undefined;
    const { driver, pty } = createDriver({
      appendText(artifactPath) {
        if (artifactPath !== "artifacts/output.log") {
          return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
          releaseOutputAppend = resolve;
        });
      },
    });

    let rawResolved = false;
    let screenResolved = false;
    const rawWaiter = driver.expectRaw("READY", futureDeadline()).then(() => {
      rawResolved = true;
    });
    const screenWaiter = driver
      .expectScreen((screen) => screen.contents().includes("READY"), futureDeadline())
      .then(() => {
        screenResolved = true;
      });

    pty.emitData("READY");

    await Promise.resolve();
    await Promise.resolve();

    expect(rawResolved).toBe(false);
    expect(screenResolved).toBe(false);

    releaseOutputAppend?.();

    await expect(rawWaiter).resolves.toBeUndefined();
    await expect(screenWaiter).resolves.toBeUndefined();
  });

  test("rejects output waiters and exit waiters when output evidence append fails", async () => {
    let failOutputAppend: (() => void) | undefined;
    const { driver, pty } = createDriver({
      appendText(artifactPath) {
        if (artifactPath !== "artifacts/output.log") {
          return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
          failOutputAppend = resolve;
        }).then(() => {
          throw new Error("disk full");
        });
      },
    });

    const rawWaiter = driver.expectRaw("READY", futureDeadline());
    const screenWaiter = driver.expectScreen(
      (screen) => screen.contents().includes("READY"),
      futureDeadline()
    );
    const exitWaiter = driver.waitForExit(futureDeadline());
    const rawFailure = rawWaiter.then(
      () => ({ status: "resolved" as const }),
      (error) => ({ status: "rejected" as const, error })
    );
    const screenFailure = screenWaiter.then(
      () => ({ status: "resolved" as const }),
      (error) => ({ status: "rejected" as const, error })
    );
    const exitFailure = exitWaiter.then(
      () => ({ status: "resolved" as const }),
      (error) => ({ status: "rejected" as const, error })
    );

    pty.emitData("READY");
    await Promise.resolve();
    await Promise.resolve();
    expect(failOutputAppend).toBeDefined();
    failOutputAppend?.();

    await expect(rawFailure).resolves.toMatchObject({
      status: "rejected",
      error: expect.objectContaining({
        message: "PTY driver async failure: Error: disk full",
      }),
    });
    await expect(screenFailure).resolves.toMatchObject({
      status: "rejected",
      error: expect.objectContaining({
        message: "PTY driver async failure: Error: disk full",
      }),
    });
    await expect(exitFailure).resolves.toMatchObject({
      status: "rejected",
      error: expect.objectContaining({
        message: "PTY driver async failure: Error: disk full",
      }),
    });
    await expect(driver.waitForExit(futureDeadline())).rejects.toThrow(
      "PTY driver async failure: Error: disk full"
    );
  });
});
