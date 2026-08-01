import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn as nodePtySpawn, type IPty, type IPtyForkOptions } from "node-pty";
import { CaseArtifacts } from "../artifacts.js";
import { HarnessError } from "../types.js";
import {
  controlChord,
  namedKey,
  sgrMouse,
  type MouseEvent,
  type NamedKey,
} from "./terminal-input.js";
import { ScreenModel } from "./screen-model.js";

const DEFAULT_TERM_NAME = "xterm-256color";
const RECENT_RAW_LIMIT = 4_096;

export interface DisposableLike {
  dispose(): void;
}

export interface ScreenLike {
  write(data: string | Uint8Array): Promise<void>;
  resize(cols: number, rows: number): void;
  contents(): string;
  cursor(): { col: number; row: number };
  dispose?(): void;
  close?(): void;
}

export interface PtyProcessLike {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  readonly process: string;
  handleFlowControl: boolean;
  readonly onData: (listener: (data: string) => void) => DisposableLike;
  readonly onExit: (
    listener: (event: { exitCode: number; signal?: number }) => void
  ) => DisposableLike;
  resize(cols: number, rows: number): void;
  clear(): void;
  write(data: string | Buffer): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

export interface PtySpawnOptions extends IPtyForkOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string | undefined>;
  encoding: string;
}

export interface PtySpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
  inputPath: string;
  outputPath: string;
  name?: string;
  artifacts?: Pick<CaseArtifacts, "appendText">;
}

export interface PtyDriverDependencies {
  spawnPty?: (
    file: string,
    args: string[],
    options: PtySpawnOptions
  ) => PtyProcessLike;
  createScreen?: (cols: number, rows: number) => ScreenLike;
  appendText?: (path: string, text: string) => Promise<void>;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

type Deadline = Date | number;

interface RawWaiter {
  marker: string;
  tail: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface ScreenWaiter {
  predicate: (screen: ScreenLike) => boolean;
  label: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function appendPathText(filePath: string, text: string): Promise<void> {
  return mkdir(path.dirname(filePath), { recursive: true }).then(() =>
    appendFile(filePath, text, "utf8")
  );
}

function asAbsoluteDeadline(deadline: Deadline): number {
  return deadline instanceof Date ? deadline.getTime() : deadline;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new HarnessError("prerequisite", `${label} must be positive integers`);
  }
}

function defaultSpawnPty(
  file: string,
  args: string[],
  options: PtySpawnOptions
): PtyProcessLike {
  return nodePtySpawn(file, args, options) as unknown as IPty;
}

function defaultScreen(cols: number, rows: number): ScreenLike {
  return new ScreenModel(cols, rows);
}

export class PtyDriver {
  public static spawn(
    spec: PtySpawnSpec,
    dependencies: PtyDriverDependencies = {}
  ): PtyDriver {
    return new PtyDriver(spec, dependencies);
  }

  private readonly pty: PtyProcessLike;
  private readonly screen: ScreenLike;
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof globalThis.setTimeout;
  private readonly clearTimeoutFn: typeof globalThis.clearTimeout;
  private readonly appendText: (path: string, text: string) => Promise<void>;
  private readonly subscriptions: DisposableLike[];
  private readonly durableRawChunks: string[] = [];
  private readonly rawWaiters = new Set<RawWaiter>();
  private readonly screenWaiters = new Set<ScreenWaiter>();
  private readonly exitWaiters = new Set<{
    resolve: (exitCode: number) => void;
    reject: (error: unknown) => void;
  }>();
  private inputQueue: Promise<void> = Promise.resolve();
  private orderedOutputQueue: Promise<void> = Promise.resolve();
  private recentRaw = "";
  private lastActivityAt: number;
  private pendingError: unknown;
  private exitResult?: Promise<number>;
  private closed = false;

  private constructor(
    private readonly spec: PtySpawnSpec,
    dependencies: PtyDriverDependencies
  ) {
    assertPositiveInteger(spec.cols, "PTY dimensions");
    assertPositiveInteger(spec.rows, "PTY dimensions");

    this.now = dependencies.now ?? (() => Date.now());
    this.setTimeoutFn = dependencies.setTimeout ?? globalThis.setTimeout;
    this.clearTimeoutFn = dependencies.clearTimeout ?? globalThis.clearTimeout;
    this.appendText =
      dependencies.appendText ??
      (spec.artifacts
        ? (artifactPath, text) => spec.artifacts!.appendText(artifactPath, text)
        : appendPathText);
    this.lastActivityAt = this.now();
    this.screen = (dependencies.createScreen ?? defaultScreen)(spec.cols, spec.rows);
    this.pty = (dependencies.spawnPty ?? defaultSpawnPty)(spec.file, spec.args, {
      name: spec.name ?? spec.env.TERM ?? DEFAULT_TERM_NAME,
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: spec.env,
      encoding: "utf8",
    });
    this.subscriptions = [
      this.pty.onData((data) => this.handleData(data)),
      this.pty.onExit((event) => {
        this.exitResult ??= this.finalizeExit(event.exitCode);
      }),
    ];
  }

  public writeRaw(data: string): void {
    this.throwIfPendingError();
    this.enqueueInput(data);
    this.pty.write(data);
  }

  public writeText(text: string): void {
    this.writeRaw(text);
  }

  public writeLine(text: string): void {
    this.writeRaw(`${text}\r`);
  }

  public sendControl(key: string): void {
    this.writeRaw(controlChord(key));
  }

  public sendKey(key: NamedKey): void {
    this.writeRaw(namedKey(key));
  }

  public sendMouse(event: MouseEvent): void {
    this.writeRaw(sgrMouse(event));
  }

  public resize(cols: number, rows: number): void {
    this.throwIfPendingError();
    assertPositiveInteger(cols, "PTY dimensions");
    assertPositiveInteger(rows, "PTY dimensions");
    this.pty.resize(cols, rows);
    this.enqueueOrderedOutput(async () => {
      this.screen.resize(cols, rows);
      this.markActivity();
      this.resolveScreenWaiters();
    });
  }

  public expectRaw(marker: string, deadline: Deadline): Promise<void> {
    if (this.pendingError) {
      return Promise.reject(this.pendingError);
    }
    if (this.containsMarker(marker)) {
      return Promise.resolve();
    }

    return this.waitForDeadline(
      deadline,
      `marker ${JSON.stringify(marker)}`,
      (resolve, reject) => {
        const waiter: RawWaiter = {
          marker,
          tail: this.trailingRaw(marker.length - 1),
          resolve,
          reject,
        };
        this.rawWaiters.add(waiter);
        return () => {
          this.rawWaiters.delete(waiter);
        };
      }
    );
  }

  public async waitForQuiet(quietPeriodMs: number, deadline: Deadline): Promise<void> {
    this.throwIfPendingError();
    assertPositiveInteger(quietPeriodMs, "quietPeriodMs");

    const deadlineAt = asAbsoluteDeadline(deadline);
    while (true) {
      this.throwIfPendingError();

      const remainingQuietMs = quietPeriodMs - (this.now() - this.lastActivityAt);
      if (remainingQuietMs <= 0) {
        return;
      }

      const remainingDeadlineMs = deadlineAt - this.now();
      if (remainingDeadlineMs <= 0) {
        throw this.timeoutError(`quiet period ${quietPeriodMs}ms`);
      }

      await new Promise<void>((resolve) => {
        this.setTimeoutFn(resolve, Math.min(remainingQuietMs, remainingDeadlineMs));
      });
    }
  }

  public expectScreen(
    predicate: (screen: ScreenLike) => boolean,
    deadline: Deadline
  ): Promise<void> {
    if (this.pendingError) {
      return Promise.reject(this.pendingError);
    }
    if (predicate(this.screen)) {
      return Promise.resolve();
    }

    return this.waitForDeadline(
      deadline,
      `screen predicate ${predicate.name || "<anonymous>"}`,
      (resolve, reject) => {
        const waiter: ScreenWaiter = {
          predicate,
          label: predicate.name || "<anonymous>",
          resolve,
          reject,
        };
        this.screenWaiters.add(waiter);
        return () => {
          this.screenWaiters.delete(waiter);
        };
      }
    );
  }

  public waitForExit(deadline: Deadline): Promise<number> {
    if (this.pendingError) {
      return Promise.reject(this.pendingError);
    }
    if (this.exitResult) {
      return this.waitForDeadline(deadline, "process exit", (resolve, reject) => {
        this.exitResult!.then(resolve, reject);
        return () => {};
      });
    }

    return this.waitForDeadline(deadline, "process exit", (resolve, reject) => {
      this.exitWaiters.add({ resolve, reject });
      return () => {
        for (const waiter of this.exitWaiters) {
          if (waiter.resolve === resolve && waiter.reject === reject) {
            this.exitWaiters.delete(waiter);
            break;
          }
        }
      };
    });
  }

  public kill(): void {
    if (this.exitResult) {
      return;
    }

    this.pty.kill();
  }

  private waitForDeadline<T>(
    deadline: Deadline,
    label: string,
    register: (
      resolve: (value: T) => void,
      reject: (error: unknown) => void
    ) => () => void
  ): Promise<T> {
    const deadlineAt = asAbsoluteDeadline(deadline);
    const remainingMs = deadlineAt - this.now();

    if (remainingMs <= 0) {
      return Promise.reject(this.timeoutError(label));
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let cleanup = () => {};
      const timer = this.setTimeoutFn(() => {
        finish(reject, this.timeoutError(label));
      }, remainingMs);

      const finish = (
        callback: (value: T | PromiseLike<T>) => void | ((reason?: unknown) => void),
        value: T | unknown
      ): void => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        this.clearTimeoutFn(timer);
        (callback as (arg: T | unknown) => void)(value);
      };

      cleanup = register(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );
    });
  }

  private enqueueInput(data: string): void {
    this.inputQueue = this.inputQueue
      .then(() => this.appendText(this.spec.inputPath, data))
      .catch((error) => {
        this.recordAsyncError(error);
      });
  }

  private handleData(data: string): void {
    this.recentRaw = `${this.recentRaw}${data}`.slice(-RECENT_RAW_LIMIT);
    this.enqueueOrderedOutput(async () => {
      await this.appendText(this.spec.outputPath, data);
      this.durableRawChunks.push(data);
      this.resolveRawWaiters(data);
      await this.screen.write(data);
      this.markActivity();
      this.resolveScreenWaiters();
    });
  }

  private enqueueOrderedOutput(operation: () => Promise<void>): void {
    this.orderedOutputQueue = this.orderedOutputQueue
      .then(async () => {
        this.throwIfPendingError();
        await operation();
      })
      .catch((error) => {
        this.recordAsyncError(error);
      });
  }

  private resolveRawWaiters(chunk: string): void {
    for (const waiter of [...this.rawWaiters]) {
      const combined = `${waiter.tail}${chunk}`;
      if (combined.includes(waiter.marker)) {
        this.rawWaiters.delete(waiter);
        waiter.resolve();
        continue;
      }

      waiter.tail =
        waiter.marker.length > 1
          ? combined.slice(-(waiter.marker.length - 1))
          : "";
    }
  }

  private resolveScreenWaiters(): void {
    for (const waiter of [...this.screenWaiters]) {
      if (!waiter.predicate(this.screen)) {
        continue;
      }

      this.screenWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private containsMarker(marker: string): boolean {
    if (marker.length === 0) {
      return true;
    }

    let tail = "";
    for (const chunk of this.durableRawChunks) {
      const combined = `${tail}${chunk}`;
      if (combined.includes(marker)) {
        return true;
      }
      tail = marker.length > 1 ? combined.slice(-(marker.length - 1)) : "";
    }
    return false;
  }

  private trailingRaw(length: number): string {
    if (length <= 0) {
      return "";
    }

    let tail = "";
    for (const chunk of this.durableRawChunks) {
      tail = `${tail}${chunk}`.slice(-length);
    }
    return tail;
  }

  private timeoutError(label: string): HarnessError {
    const cursor = this.screen.cursor();
    return new HarnessError(
      "timeout",
      `Timed out waiting for ${label}; recentRaw=${JSON.stringify(this.recentRaw)}; rendered=${JSON.stringify(
        this.screen.contents()
      )}; cursor=(${cursor.col},${cursor.row})`
    );
  }

  private recordAsyncError(error: unknown): void {
    if (this.pendingError) {
      return;
    }

    this.pendingError =
      error instanceof HarnessError
        ? error
        : new HarnessError("pty", `PTY driver async failure: ${String(error)}`, {
            cause: error,
          });

    for (const waiter of this.rawWaiters) {
      waiter.reject(this.pendingError);
    }
    this.rawWaiters.clear();

    for (const waiter of this.screenWaiters) {
      waiter.reject(this.pendingError);
    }
    this.screenWaiters.clear();

    for (const waiter of this.exitWaiters) {
      waiter.reject(this.pendingError);
    }
    this.exitWaiters.clear();
  }

  private markActivity(): void {
    this.lastActivityAt = this.now();
  }

  private throwIfPendingError(): void {
    if (this.pendingError) {
      throw this.pendingError;
    }
  }

  private async finalizeExit(exitCode: number): Promise<number> {
    try {
      await this.orderedOutputQueue;
      await this.inputQueue;
      this.throwIfPendingError();
      return exitCode;
    } finally {
      this.disposeOwnedResources();
    }
  }

  private disposeOwnedResources(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }

    this.screen.close?.();
    if (!this.screen.close && this.screen.dispose) {
      this.screen.dispose();
    }

    if (!this.exitResult) {
      return;
    }

    this.exitResult.then(
      (exitCode) => {
        for (const waiter of this.exitWaiters) {
          waiter.resolve(exitCode);
        }
        this.exitWaiters.clear();
      },
      (error) => {
        for (const waiter of this.exitWaiters) {
          waiter.reject(error);
        }
        this.exitWaiters.clear();
      }
    );
  }
}
