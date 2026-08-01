import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { HarnessError } from "../src/types.js";

const browserModule = await import("../src/drivers/browser.js").catch(() => null);
const BrowserDriver = (browserModule as { BrowserDriver?: new (...args: any[]) => any } | null)?.BrowserDriver;
const BrowserSurfaceRegistry = (
  browserModule as { BrowserSurfaceRegistry?: new (...args: any[]) => any } | null
)?.BrowserSurfaceRegistry;
const stopBrowserTracing = (
  browserModule as { stopBrowserTracing?: (context: unknown, path: string) => Promise<void> } | null
)?.stopBrowserTracing;

class FakeTimeoutError extends Error {
  public constructor(message = "timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

class FakeClock {
  public nowMs = 0;
  public readonly sleepCalls: number[] = [];

  public now(): number {
    return this.nowMs;
  }

  public async sleep(ms: number): Promise<void> {
    this.sleepCalls.push(ms);
    this.nowMs += ms;
  }
}

class FakeTracing {
  public readonly startCalls: unknown[] = [];
  public readonly stopCalls: unknown[] = [];
  public stopError?: unknown;
  public readonly stopErrors: unknown[] = [];

  public constructor(private readonly log: string[]) {}

  public async start(options: unknown): Promise<void> {
    this.startCalls.push(options);
    this.log.push("trace:start");
  }

  public async stop(options: unknown): Promise<void> {
    this.stopCalls.push(options);
    this.log.push(`trace:stop:${String((options as { path?: string }).path ?? "")}`);
    if (this.stopErrors.length > 0) {
      throw this.stopErrors.shift();
    }
    if (this.stopError) {
      throw this.stopError;
    }
  }
}

class FakeKeyboard {
  public readonly insertTexts: string[] = [];
  public readonly pressCalls: string[] = [];

  public async insertText(text: string): Promise<void> {
    this.insertTexts.push(text);
  }

  public async press(key: string): Promise<void> {
    this.pressCalls.push(key);
  }
}

class FakeConsoleMessage {
  public constructor(
    private readonly messageType: string,
    private readonly messageText: string
  ) {}

  public type(): string {
    return this.messageType;
  }

  public text(): string {
    return this.messageText;
  }
}

class FakeRequest {
  public constructor(
    private readonly requestUrl: string,
    private readonly errorText?: string
  ) {}

  public url(): string {
    return this.requestUrl;
  }

  public failure(): { errorText?: string } | null {
    return this.errorText ? { errorText: this.errorText } : null;
  }
}

class FakeLocator {
  public readonly waitCalls: Array<Record<string, unknown>> = [];
  public readonly clickCalls: Array<Record<string, unknown> | undefined> = [];
  public readonly nested = new Map<string, FakeLocator>();
  public readonly roles = new Map<string, FakeLocator>();
  public readonly getAttributeCalls: Array<{
    name: string;
    options?: Record<string, unknown>;
  }> = [];
  public countValue = 0;
  public countValues?: number[];
  public waitError?: unknown;
  public waitErrors?: Array<unknown>;
  public waitImpl?: (options?: Record<string, unknown>) => Promise<void> | void;
  public clickError?: unknown;
  public allInnerTextsValue: string[] = [];
  public attributeValue: string | null = null;
  public attributeValues?: Array<string | null>;
  public getAttributeError?: unknown;

  public constructor(
    public readonly selector: string,
    private readonly log: string[]
  ) {}

  public locator(selector: string): FakeLocator {
    const existing = this.nested.get(selector);
    if (existing) {
      return existing;
    }

    const locator = new FakeLocator(`${this.selector} >> ${selector}`, this.log);
    this.nested.set(selector, locator);
    return locator;
  }

  public async waitFor(options?: Record<string, unknown>): Promise<void> {
    this.waitCalls.push(options ?? {});
    this.log.push(`wait:${this.selector}`);
    if (this.waitErrors && this.waitErrors.length > 0) {
      const error = this.waitErrors.shift();
      if (error !== undefined) {
        throw error;
      }
    }
    if (this.waitError) {
      throw this.waitError;
    }
    await this.waitImpl?.(options);
  }

  public async click(options?: Record<string, unknown>): Promise<void> {
    this.clickCalls.push(options);
    this.log.push(`click:${this.selector}`);
    if (this.clickError) {
      throw this.clickError;
    }
  }

  public async count(): Promise<number> {
    if (this.countValues && this.countValues.length > 0) {
      return this.countValues.shift() ?? 0;
    }
    return this.countValue;
  }

  public async getAttribute(name: string, options?: Record<string, unknown>): Promise<string | null> {
    this.getAttributeCalls.push({ name, options });
    if (this.getAttributeError) {
      throw this.getAttributeError;
    }
    if (this.attributeValues && this.attributeValues.length > 0) {
      return this.attributeValues.shift() ?? null;
    }
    return this.attributeValue;
  }

  public async allInnerTexts(): Promise<string[]> {
    return this.allInnerTextsValue;
  }

  public getByRole(role: string, options: { name: string }): FakeLocator {
    const key = `${role}:${options.name}`;
    const existing = this.roles.get(key);
    if (existing) {
      return existing;
    }

    const locator = new FakeLocator(`${this.selector} >> role=${role}[name=${options.name}]`, this.log);
    this.roles.set(key, locator);
    return locator;
  }

  public registerRoleLocator(role: string, name: string, locator?: FakeLocator): FakeLocator {
    const next = locator ?? new FakeLocator(`${this.selector} >> role=${role}[name=${name}]`, this.log);
    this.roles.set(`${role}:${name}`, next);
    return next;
  }
}

class FakePage {
  public readonly keyboard = new FakeKeyboard();
  public readonly locatorCalls: string[] = [];
  public readonly roleCalls: Array<{ role: string; name: string }> = [];
  public readonly gotoCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
  public readonly screenshotCalls: Array<Record<string, unknown>> = [];
  public readonly viewportCalls: Array<{ width: number; height: number }> = [];
  public readonly evaluateCalls: Array<{ arg: unknown }> = [];
  public closeCalls = 0;
  public gotoError?: unknown;
  public closeError?: unknown;
  public screenshotError?: unknown;
  public viewportError?: unknown;
  public evaluateError?: unknown;
  private readonly locatorMap = new Map<string, FakeLocator>();
  private readonly roleMap = new Map<string, FakeLocator>();
  private readonly consoleListeners = new Set<(message: FakeConsoleMessage) => void>();
  private readonly requestFailedListeners = new Set<(request: FakeRequest) => void>();

  public constructor(private readonly log: string[]) {}

  public locator(selector: string): FakeLocator {
    this.locatorCalls.push(selector);
    const existing = this.locatorMap.get(selector);
    if (existing) {
      return existing;
    }

    const locator = new FakeLocator(selector, this.log);
    this.locatorMap.set(selector, locator);
    return locator;
  }

  public registerLocator(selector: string, locator?: FakeLocator): FakeLocator {
    const next = locator ?? new FakeLocator(selector, this.log);
    this.locatorMap.set(selector, next);
    return next;
  }

  public getByRole(role: string, options: { name: string }): FakeLocator {
    this.roleCalls.push({ role, name: options.name });
    const key = `${role}:${options.name}`;
    const existing = this.roleMap.get(key);
    if (existing) {
      return existing;
    }

    const locator = new FakeLocator(`role=${role}[name=${options.name}]`, this.log);
    this.roleMap.set(key, locator);
    return locator;
  }

  public registerRoleLocator(role: string, name: string, locator?: FakeLocator): FakeLocator {
    const next = locator ?? new FakeLocator(`role=${role}[name=${name}]`, this.log);
    this.roleMap.set(`${role}:${name}`, next);
    return next;
  }

  public on(
    event: "console" | "requestfailed",
    listener: ((message: FakeConsoleMessage) => void) | ((request: FakeRequest) => void)
  ): void {
    if (event === "console") {
      this.consoleListeners.add(listener as (message: FakeConsoleMessage) => void);
      return;
    }

    this.requestFailedListeners.add(listener as (request: FakeRequest) => void);
  }

  public async goto(url: string, options: Record<string, unknown>): Promise<void> {
    this.gotoCalls.push({ url, options });
    this.log.push(`goto:${url}`);
    if (this.gotoError) {
      throw this.gotoError;
    }
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError) {
      throw this.closeError;
    }
  }

  public async screenshot(options: Record<string, unknown>): Promise<void> {
    this.screenshotCalls.push(options);
    if (this.screenshotError) {
      throw this.screenshotError;
    }
  }

  public async setViewportSize(viewport: { width: number; height: number }): Promise<void> {
    this.viewportCalls.push(viewport);
    if (this.viewportError) {
      throw this.viewportError;
    }
  }

  public evaluateImpl?: <A, R>(fn: (arg: A) => R | Promise<R>, arg: A) => Promise<R>;

  public async evaluate<A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
    this.evaluateCalls.push({ arg });
    if (this.evaluateError) {
      throw this.evaluateError;
    }
    if (this.evaluateImpl) {
      return this.evaluateImpl(fn, arg);
    }
    // Fake: record the call but do not execute browser-only code in Node.js context.
    return undefined as unknown as R;
  }

  public emitConsole(type: string, text: string): void {
    const message = new FakeConsoleMessage(type, text);
    for (const listener of this.consoleListeners) {
      listener(message);
    }
  }

  public emitRequestFailed(url: string, errorText?: string): void {
    const request = new FakeRequest(url, errorText);
    for (const listener of this.requestFailedListeners) {
      listener(request);
    }
  }

  public consoleListenerCount(): number {
    return this.consoleListeners.size;
  }

  public requestFailedListenerCount(): number {
    return this.requestFailedListeners.size;
  }
}

class FakeBrowserContext {
  public readonly tracing: FakeTracing;
  public newPageCalls = 0;
  public closeCalls = 0;
  public readonly addInitScriptCalls: Array<{ script: unknown; arg: unknown }> = [];
  public closeError?: unknown;

  public constructor(
    private readonly pages: FakePage[],
    private readonly log: string[]
  ) {
    this.tracing = new FakeTracing(log);
  }

  public async newPage(): Promise<FakePage> {
    const page = this.pages[this.newPageCalls];
    if (!page) {
      throw new Error("No fake page available");
    }

    this.newPageCalls += 1;
    return page;
  }

  public async addInitScript(script: unknown, arg: unknown): Promise<void> {
    this.addInitScriptCalls.push({ script, arg });
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
    this.log.push(`context-close:${this.closeCalls}`);
    if (this.closeError) {
      throw this.closeError;
    }
  }
}

class FakeBrowser {
  public readonly newContextCalls: Array<Record<string, unknown>> = [];
  public closeCalls = 0;

  public constructor(private readonly contexts: FakeBrowserContext[]) {}

  public async newContext(options?: Record<string, unknown>): Promise<FakeBrowserContext> {
    this.newContextCalls.push(options ?? {});
    const context = this.contexts[this.newContextCalls.length - 1];
    if (!context) {
      throw new Error("No fake browser context available");
    }
    return context;
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function requireBrowserDriver(): new (...args: any[]) => any {
  expect(BrowserDriver).toBeDefined();
  return BrowserDriver!;
}

function requireStopBrowserTracing(): (context: unknown, path: string) => Promise<void> {
  expect(stopBrowserTracing).toBeDefined();
  return stopBrowserTracing!;
}

function requireBrowserSurfaceRegistry(): new (...args: any[]) => any {
  expect(BrowserSurfaceRegistry).toBeDefined();
  return BrowserSurfaceRegistry!;
}

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

function createDriver(options?: {
  clock?: FakeClock;
  pages?: FakePage[];
  log?: string[];
  pollIntervalMs?: number;
  browser?: FakeBrowser;
  artifactDir?: string;
}) {
  const log = options?.log ?? [];
  const clock = options?.clock ?? new FakeClock();
  const pages = options?.pages ?? [new FakePage(log)];
  const [page] = pages;
  const context = new FakeBrowserContext(pages.slice(1), log);
  const runtime: Record<string, unknown> = { context, page };
  if (options?.browser && options.artifactDir) {
    const Registry = requireBrowserSurfaceRegistry();
    runtime.browserSurfaceRegistry = new Registry({
      browser: options.browser,
      artifactsDir: options.artifactDir
    });
  }
  const Driver = requireBrowserDriver();
  const driver = new Driver(
    runtime,
    {
      now: () => clock.now(),
      sleep: (ms: number) => clock.sleep(ms),
      pollIntervalMs: options?.pollIntervalMs ?? 25
    }
  );

  return { driver, context, page, pages, clock, log };
}

describe("BrowserDriver", () => {
  test("loads the browser driver module", () => {
    expect(BrowserDriver).toBeDefined();
  });

  test("starts tracing before navigation and waits for the semantic session list", async () => {
    const log: string[] = [];
    const page = new FakePage(log);
    page.registerLocator('[data-testid="session-list"]');
    const { driver, context } = createDriver({ log, pages: [page] });

    await driver.open("http://127.0.0.1:43123/", 1_000);

    expect(context.tracing.startCalls).toHaveLength(1);
    expect(log).toEqual([
      "trace:start",
      "goto:http://127.0.0.1:43123/",
      'wait:[data-testid="session-list"]'
    ]);
  });

  test("scopes the terminal button to the selected session item and retries until it appears", async () => {
    const log: string[] = [];
    const clock = new FakeClock();
    const page = new FakePage(log);
    page.registerLocator('[data-testid="session-list"]');
    const terminal = page.registerLocator(
      '[data-testid="session-terminal"][data-session-id="dar-session"]'
    );
    const selector = '[data-testid="session-item"][data-session-id="dar-session"]';
    const session = page.registerLocator(selector);
    const staleButton = page.registerRoleLocator("button", "Open terminal");
    const targetButton = session.registerRoleLocator("button", "Open terminal");
    targetButton.countValues = [0, 1];
    terminal.waitImpl = async () => {
      if (targetButton.clickCalls.length === 0) {
        throw new FakeTimeoutError("terminal not visible yet");
      }
    };
    const { driver } = createDriver({ clock, log, pages: [page], pollIntervalMs: 25 });

    await driver.open("http://127.0.0.1:43123/", 1_000);
    await driver.openTerminal("dar-session", 60);

    expect(page.roleCalls).toEqual([]);
    expect(staleButton.clickCalls).toHaveLength(0);
    expect(targetButton.clickCalls).toHaveLength(1);
    expect(clock.sleepCalls).toEqual([25]);
    expect(log).toContain(
      'wait:[data-testid="session-terminal"][data-session-id="dar-session"]'
    );
    expect(log).toContain(`click:${selector} >> role=button[name=Open terminal]`);
    expect(log).not.toContain("click:role=button[name=Open terminal]");
  });

  test("waits for the requested terminal readiness instead of generic terminal visibility", async () => {
    const log: string[] = [];
    const clock = new FakeClock();
    const page = new FakePage(log);
    page.registerLocator('[data-testid="session-list"]');
    page.registerLocator('[data-testid="session-terminal"]');
    const readySelector =
      '[data-testid="session-terminal"][data-session-id="dar-session"]';
    const readyTerminal = page.registerLocator(readySelector);
    const selector = '[data-testid="session-item"][data-session-id="dar-session"]';
    const session = page.registerLocator(selector);
    const openButton = session.registerRoleLocator("button", "Open terminal");
    openButton.countValues = [0, 1];
    readyTerminal.waitImpl = async () => {
      if (openButton.clickCalls.length === 0) {
        throw new FakeTimeoutError("requested terminal not ready yet");
      }
    };
    const { driver } = createDriver({ clock, log, pages: [page], pollIntervalMs: 25 });

    await driver.open("http://127.0.0.1:43123/", 1_000);
    await driver.openTerminal("dar-session", 60);

    expect(openButton.clickCalls).toHaveLength(1);
    expect(log).toContain(`wait:${readySelector}`);
    expect(log).not.toContain('wait:[data-testid="session-terminal"]');
    expect(clock.sleepCalls).toEqual([25]);
  });

  test("escapes semantic session selectors and terminal readiness selectors", async () => {
    const log: string[] = [];
    const page = new FakePage(log);
    page.registerLocator('[data-testid="session-list"]');
    const { driver } = createDriver({ log, pages: [page] });
    const id = 'quote"slash\\\\tail';
    const selector =
      '[data-testid="session-item"][data-session-id="quote\\"slash\\\\\\\\tail"]';
    const readySelector =
      '[data-testid="session-terminal"][data-session-id="quote\\"slash\\\\\\\\tail"]';
    page.registerLocator(selector).registerRoleLocator("button", "Open terminal");
    page.registerLocator(readySelector);

    await driver.open("http://127.0.0.1:43123/", 1_000);
    await driver.openTerminal(id, 1_000);

    expect(page.locatorCalls).toContain(selector);
    expect(page.locatorCalls).toContain(readySelector);
    expect(log).toContain(`click:${selector}`);
    expect(page.roleCalls).toEqual([]);
    expect(log).toContain(`wait:${readySelector}`);
  });

  test("includes requested and current terminal readiness in timeout diagnostics", async () => {
    const clock = new FakeClock();
    const page = new FakePage([]);
    page.registerLocator('[data-testid="session-list"]');
    const terminal = page.registerLocator('[data-testid="session-terminal"]');
    terminal.attributeValues = ["old-session", "old-session", "old-session"];
    const readySelector =
      '[data-testid="session-terminal"][data-session-id="dar-session"]';
    const readyTerminal = page.registerLocator(readySelector);
    readyTerminal.waitError = new FakeTimeoutError("terminal never became ready");
    const selector = '[data-testid="session-item"][data-session-id="dar-session"]';
    const session = page.registerLocator(selector);
    session.registerRoleLocator("button", "Open terminal").countValue = 0;
    const { driver } = createDriver({ clock, pages: [page], pollIntervalMs: 25 });

    await driver.open("http://127.0.0.1:43123/", 1_000);
    let error: Error | undefined;
    try {
      await driver.openTerminal("dar-session", 40);
    } catch (caught) {
      error = caught as Error;
    }

    expect(error).toMatchObject({
      name: "HarnessError",
      kind: "timeout"
    });
    expect(error?.message).toContain('requestedSessionId="dar-session"');
    expect(error?.message).toContain('currentReadySessionId="old-session"');
    expect(error?.message).toContain(`readySelector=${readySelector}`);
  });

  test("rejects control characters in session ids before building selectors", async () => {
    const page = new FakePage([]);
    const { driver } = createDriver({ pages: [page] });

    await expect(driver.openTerminal("bad\u0007id", 1_000)).rejects.toBeInstanceOf(HarnessError);
    expect(page.locatorCalls).toEqual([]);
  });

  test("captures console and failed network history in timeout diagnostics", async () => {
    const page = new FakePage([]);
    const selector = '[data-testid="session-item"][data-session-id="dar-session"]';
    const session = page.registerLocator(selector);
    session.getAttributeError = new FakeTimeoutError("missing locator");
    const { driver } = createDriver({ pages: [page] });

    page.emitConsole("warning", "terminal websocket lagged");
    page.emitRequestFailed("http://127.0.0.1:43123/api/sessions", "net::ERR_ABORTED");

    let error: Error | undefined;
    try {
      await driver.waitForSessionStatus("dar-session", "running", 40);
    } catch (caught) {
      error = caught as Error;
    }

    expect(error).toMatchObject({
      name: "HarnessError",
      kind: "timeout"
    });
    expect(error?.message).toContain(
      'selector=[data-testid="session-item"][data-session-id="dar-session"]'
    );
    expect(error?.message).toContain('id="dar-session"');
    expect(error?.message).toContain('expectedStatus="running"');
    expect(error?.message).toContain(    'currentStatus=null');
    expect(error?.message).toContain("warning: terminal websocket lagged");
    expect(error?.message).toContain(
      "http://127.0.0.1:43123/api/sessions :: net::ERR_ABORTED"
    );
    expect(session.getAttributeCalls).toEqual([
    {
      name: "data-session-status",
      options: { timeout: 40 }
    }
    ]);
  });

  test("bounds each session status probe to the remaining absolute deadline", async () => {
    const clock = new FakeClock();
    const page = new FakePage([]);
    const selector = '[data-testid="session-item"][data-session-id="dar-session"]';
    const session = page.registerLocator(selector);
    session.attributeValue = "starting";
    const { driver } = createDriver({ clock, pages: [page], pollIntervalMs: 25 });

    await expect(driver.waitForSessionStatus("dar-session", "running", 40)).rejects.toMatchObject({
    name: "HarnessError",
    kind: "timeout"
    });

    expect(session.getAttributeCalls).toEqual([
    {
      name: "data-session-status",
      options: { timeout: 40 }
    },
    {
      name: "data-session-status",
      options: { timeout: 15 }
    }
    ]);
    expect(clock.sleepCalls).toEqual([25, 15]);
    expect(clock.nowMs).toBe(40);
  });

  test("reads terminal text from accessibility rows before falling back to xterm rows", async () => {
    const page = new FakePage([]);
    const terminal = page.registerLocator('[data-testid="session-terminal"]');
    terminal.locator(".xterm-accessibility-tree > div").allInnerTextsValue = ["boot", "ready"];
    const { driver } = createDriver({ pages: [page] });

    await expect(
      driver.waitForTerminalText("boot\nready", 50)
    ).resolves.toBeUndefined();
    expect(page.locatorCalls).toContain('[data-testid="session-terminal"]');
  });

  test("falls back to rendered xterm rows when accessibility rows are empty", async () => {
    const page = new FakePage([]);
    const terminal = page.registerLocator('[data-testid="session-terminal"]');
    terminal.locator(".xterm-accessibility-tree > div").allInnerTextsValue = [];
    terminal.locator(".xterm-rows > div").allInnerTextsValue = ["row one", "row two"];
    const { driver } = createDriver({ pages: [page] });

    await expect(driver.waitForTerminalText("row one\nrow two", 50)).resolves.toBeUndefined();
  });

  test("returns a terminal text snapshot using the same accessibility-first strategy", async () => {
    const page = new FakePage([]);
    const terminal = page.registerLocator('[data-testid="session-terminal"]');
    terminal.locator(".xterm-accessibility-tree > div").allInnerTextsValue = ["boot", "ready"];
    const { driver } = createDriver({ pages: [page] });

    await expect(driver.terminalText()).resolves.toBe("boot\nready");

    terminal.locator(".xterm-accessibility-tree > div").allInnerTextsValue = [];
    terminal.locator(".xterm-rows > div").allInnerTextsValue = ["fallback"];
    await expect(driver.terminalText()).resolves.toBe("fallback");
  });

  test("sends literal terminal text with insertText plus Enter and rejects newlines", async () => {
    const page = new FakePage([]);
    page.registerLocator('[data-testid="session-terminal"]');
    const { driver } = createDriver({ pages: [page] });

    await driver.sendTerminalLine('echo "$HOME" && printf "\\n"');

    expect(page.keyboard.insertTexts).toEqual(['echo "$HOME" && printf "\\n"']);
    expect(page.keyboard.pressCalls).toEqual(["Enter"]);

    await expect(driver.sendTerminalLine("bad\nline")).rejects.toBeInstanceOf(HarnessError);
  });

  test("translates Playwright timeouts and preserves tracing state across viewer reopen", async () => {
    const log: string[] = [];
    const firstPage = new FakePage(log);
    firstPage.registerLocator('[data-testid="session-list"]');
    const secondPage = new FakePage(log);
    secondPage.registerLocator('[data-testid="session-list"]');
    const { driver, context, page } = createDriver({
      log,
      pages: [firstPage, secondPage]
    });

    await driver.open("http://127.0.0.1:43123/", 1_000);
    firstPage.emitConsole("warning", "first page warning");
    await driver.closeViewer();
    await driver.reopenViewer("http://127.0.0.1:43123/", 1_000);
    secondPage.emitConsole("error", "second page error");
    secondPage.emitRequestFailed("http://127.0.0.1:43123/ws", "net::ERR_CONNECTION_RESET");

    expect(page.closeCalls).toBe(1);
    expect(context.newPageCalls).toBe(1);
    expect(context.tracing.startCalls).toHaveLength(1);
    expect(secondPage.consoleListenerCount()).toBe(1);
    expect(secondPage.requestFailedListenerCount()).toBe(1);
    expect(driver.consoleMessages()).toEqual([
      "warning: first page warning",
      "error: second page error"
    ]);
    expect(driver.failedRequests()).toEqual([
      "http://127.0.0.1:43123/ws :: net::ERR_CONNECTION_RESET"
    ]);

    secondPage.gotoError = new FakeTimeoutError("navigation timed out");
    await expect(driver.open("http://127.0.0.1:43123/", 1_000)).rejects.toMatchObject({
      name: "HarnessError",
      kind: "timeout"
    });
  });

  test("stops browser tracing only for contexts started by the driver and only once", async () => {
    const stopTracing = requireStopBrowserTracing();
    const idleContext = new FakeBrowserContext([], []);
    const log: string[] = [];
    const page = new FakePage(log);
    page.registerLocator('[data-testid="session-list"]');
    const { driver, context } = createDriver({ log, pages: [page] });

    await stopTracing(idleContext, "artifacts/idle-trace.zip");
    await driver.open("http://127.0.0.1:43123/", 1_000);
    await stopTracing(context, "artifacts/browser-trace.zip");
    await stopTracing(context, "artifacts/browser-trace-again.zip");

    expect(idleContext.tracing.stopCalls).toEqual([]);
    expect(context.tracing.stopCalls).toEqual([{ path: "artifacts/browser-trace.zip" }]);
  });

  test("creates independent browser surfaces with semantic helpers and close evidence", async () => {
    const workspace = makeWorkspace("browser-surfaces");
    const log: string[] = [];
    const defaultPage = new FakePage(log);
    const desktopPage = new FakePage(log);
    const pwaPage = new FakePage(log);
    const desktopContext = new FakeBrowserContext([desktopPage], log);
    const pwaContext = new FakeBrowserContext([pwaPage], log);
    const browser = new FakeBrowser([desktopContext, pwaContext]);
    const sessionId = "dar-session";
    const sessionSelector = '[data-testid="session-item"][data-session-id="dar-session"]';
    const readySelector = '[data-testid="session-terminal"][data-session-id="dar-session"]';

    pwaPage.registerLocator('[data-testid="session-list"]');
    const activeTerminal = pwaPage.registerLocator('[data-testid="session-terminal"]');
    activeTerminal.locator(".xterm-accessibility-tree > div").allInnerTextsValue = ["pwa ready"];
    const pwaSession = pwaPage.registerLocator(sessionSelector);
    pwaSession.registerRoleLocator("button", "Open terminal").countValue = 1;
    pwaSession.attributeValues = ["needs-attention", "build.log", "normal", "42", "running"];
    const readyTerminal = pwaPage.registerLocator(readySelector);
    readyTerminal.locator(".xterm-accessibility-tree > div").allInnerTextsValue = ["pwa ready"];
    pwaPage.registerRoleLocator("button", "Take control").countValue = 1;

    try {
      const { driver } = createDriver({
        log,
        pages: [defaultPage],
        browser,
        artifactDir: join(workspace, "artifacts")
      });
      const desktop = await driver.createSurface({
        name: "desktop",
        viewport: { width: 1440, height: 900 }
      });
      const pwa = await driver.createSurface({
        name: "pwa",
        viewport: { width: 390, height: 844 },
        displayMode: "standalone"
      });
      readyTerminal.attributeValues = [null, pwa.viewerId];
      readyTerminal.attributeValue = pwa.viewerId;

      expect(desktop.viewerId).not.toBe(pwa.viewerId);
      expect(browser.newContextCalls).toEqual([
        { viewport: { width: 1440, height: 900 } },
        { viewport: { width: 390, height: 844 } }
      ]);
      expect(desktopContext.addInitScriptCalls).toHaveLength(1);
      expect(pwaContext.addInitScriptCalls).toHaveLength(1);

      await pwa.open("http://127.0.0.1:43123/", 1_000);
      await pwa.openTerminal(sessionId, 1_000);
      await pwa.takeControl(sessionId, 1_000);
      await expect(pwa.controllerId(sessionId, 1_000)).resolves.toBe(pwa.viewerId);
      await expect(pwa.status(sessionId, 1_000)).resolves.toBe("needs-attention");
      await expect(pwa.title(sessionId, 1_000)).resolves.toBe("build.log");
      await expect(pwa.progress(sessionId, 1_000)).resolves.toEqual({ state: "normal", percent: 42 });
      await pwa.acknowledgeAttention(sessionId, 1_000);
      await pwa.resizeViewport(412, 915);
      await expect(pwa.terminalText()).resolves.toBe("pwa ready");
      await pwa.close();

      expect(pwaPage.viewportCalls).toEqual([{ width: 412, height: 915 }]);
      expect(pwaPage.closeCalls).toBe(1);
      expect(pwaContext.closeCalls).toBe(1);
      expect(desktopPage.closeCalls).toBe(0);
      expect(desktopContext.closeCalls).toBe(0);
      expect(pwaContext.tracing.stopCalls).toEqual([
        { path: join(workspace, "artifacts", "browser-surfaces", "02-pwa", "trace.zip") }
      ]);
      expect(pwaPage.screenshotCalls).toEqual([
        { path: join(workspace, "artifacts", "browser-surfaces", "02-pwa", "closing.png"), fullPage: true }
      ]);
      expect(readFileSync(join(workspace, "artifacts", "browser-surfaces", "02-pwa", "console.log"), "utf8"))
        .toBe("");
      expect(
        readFileSync(join(workspace, "artifacts", "browser-surfaces", "02-pwa", "failed-requests.log"), "utf8")
      ).toBe("");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("throws cleanup failures once and treats a second browser surface close as a no-op", async () => {
    const workspace = makeWorkspace("browser-surfaces-close-idempotent");
    const log: string[] = [];
    const defaultPage = new FakePage(log);
    const failingPage = new FakePage(log);
    const failingContext = new FakeBrowserContext([failingPage], log);
    const browser = new FakeBrowser([failingContext]);

    defaultPage.registerLocator('[data-testid="session-list"]');
    failingPage.registerLocator('[data-testid="session-list"]');
    failingContext.tracing.stopError = new Error("trace stop failed");
    failingPage.screenshotError = new Error("screenshot failed");
    failingContext.closeError = new Error("context close failed");

    try {
      const { driver } = createDriver({
        log,
        pages: [defaultPage],
        browser,
        artifactDir: join(workspace, "artifacts")
      });
      const surface = await driver.createSurface({
        name: "broken",
        viewport: { width: 1280, height: 720 }
      });

      await surface.open("http://127.0.0.1:43123/", 1_000);

      await expect(surface.close()).rejects.toMatchObject({
        name: "AggregateError",
      });
      await expect(surface.close()).resolves.toBeUndefined();

      const tracePath = join(workspace, "artifacts", "browser-surfaces", "01-broken", "trace.zip");
      const screenshotPath = join(workspace, "artifacts", "browser-surfaces", "01-broken", "closing.png");

      expect(failingContext.tracing.stopCalls).toEqual([{ path: tracePath }]);
      expect(failingPage.screenshotCalls).toEqual([{ path: screenshotPath, fullPage: true }]);
      expect(failingPage.closeCalls).toBe(1);
      expect(failingContext.closeCalls).toBe(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});


describe("BrowserSurface.acknowledgeAttentionToken", () => {
  function makeAttentionSurfaceFixture(log: string[]) {
    const primaryPage = new FakePage(log);
    primaryPage.registerLocator('[data-testid="session-list"]');
    const surfacePage = new FakePage(log);
    const surfaceContext = new FakeBrowserContext([surfacePage], log);
    const browser = new FakeBrowser([surfaceContext]);
    const workspace = resolve(import.meta.dir, "..", ".test-workspace", `ack-token-${Date.now()}`);
    mkdirSync(workspace, { recursive: true });
    const { driver } = createDriver({
      log,
      pages: [primaryPage],
      browser,
      artifactDir: join(workspace, "artifacts"),
    });
    return { driver, surfacePage, workspace };
  }

  test("calls page.evaluate with the session id and token", async () => {
    if (!BrowserDriver) return;
    const log: string[] = [];
    const { driver, surfacePage, workspace } = makeAttentionSurfaceFixture(log);

    try {
      surfacePage.registerLocator('[data-testid="session-list"]');
      const surface = await driver.createSurface({
        name: "attention",
        viewport: { width: 1280, height: 800 },
      });

      await surface.acknowledgeAttentionToken("session-abc", "token-xyz", 1_000);

      expect(surfacePage.evaluateCalls).toHaveLength(1);
      expect(surfacePage.evaluateCalls[0]!.arg).toEqual({
        id: "session-abc",
        token: "token-xyz",
        timeoutMs: 1_000,
      });

      await surface.close();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("throws prerequisite HarnessError for empty session id", async () => {
    if (!BrowserDriver) return;
    const log: string[] = [];
    const { driver, surfacePage, workspace } = makeAttentionSurfaceFixture(log);

    try {
      surfacePage.registerLocator('[data-testid="session-list"]');
      const surface = await driver.createSurface({
        name: "attention",
        viewport: { width: 1280, height: 800 },
      });

      await expect(
        surface.acknowledgeAttentionToken("", "token-xyz", 1_000)
      ).rejects.toMatchObject({ kind: "prerequisite" });
      expect(surfacePage.evaluateCalls).toHaveLength(0);

      await surface.close();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("throws prerequisite HarnessError for empty token", async () => {
    if (!BrowserDriver) return;
    const log: string[] = [];
    const { driver, surfacePage, workspace } = makeAttentionSurfaceFixture(log);

    try {
      surfacePage.registerLocator('[data-testid="session-list"]');
      const surface = await driver.createSurface({
        name: "attention",
        viewport: { width: 1280, height: 800 },
      });

      await expect(
        surface.acknowledgeAttentionToken("session-abc", "", 1_000)
      ).rejects.toMatchObject({ kind: "prerequisite" });
      expect(surfacePage.evaluateCalls).toHaveLength(0);

      await surface.close();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("wraps page.evaluate errors as browser HarnessErrors", async () => {
    if (!BrowserDriver) return;
    const log: string[] = [];
    const { driver, surfacePage, workspace } = makeAttentionSurfaceFixture(log);

    try {
      surfacePage.registerLocator('[data-testid="session-list"]');
      const surface = await driver.createSurface({
        name: "attention",
        viewport: { width: 1280, height: 800 },
      });
      surfacePage.evaluateError = new Error("WebSocket refused");

      await expect(
        surface.acknowledgeAttentionToken("session-abc", "token-xyz", 1_000)
      ).rejects.toMatchObject({ kind: "browser" });

      await surface.close();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("throws browser HarnessError when page lacks evaluate support", async () => {
    if (!BrowserDriver) return;
    const log: string[] = [];
    const { driver, surfacePage, workspace } = makeAttentionSurfaceFixture(log);

    try {
      surfacePage.registerLocator('[data-testid="session-list"]');
      const surface = await driver.createSurface({
        name: "attention",
        viewport: { width: 1280, height: 800 },
      });
      // Simulate a page that does not support evaluate (e.g., older Playwright).
      (surfacePage as unknown as Record<string, unknown>).evaluate = undefined;

      await expect(
        surface.acknowledgeAttentionToken("session-abc", "token-xyz", 1_000)
      ).rejects.toMatchObject({ kind: "browser" });

      await surface.close();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects promptly with translated HarnessError when WebSocket never opens (bounded open timeout)", async () => {
    // FAILS against current code: page.evaluate hangs forever because the script has no open
    // timeout — the Promise never settles when the WebSocket never fires "open".
    // PASSES after fix: a bounded openTimer fires after the computed remainingMs and rejects.
    if (!BrowserDriver) return;
    const log: string[] = [];
    const { driver, surfacePage, workspace } = makeAttentionSurfaceFixture(log);

    try {
      const surface = await driver.createSurface({
        name: "never-open-ws-test",
        viewport: { width: 1280, height: 800 },
      });

      // Inject a WebSocket that never fires any event — simulates a hung/refused connection.
      surfacePage.evaluateImpl = async <A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> => {
        const globalAny = globalThis as Record<string, unknown>;
        const savedLocation = globalAny["location"];
        const savedWebSocket = globalAny["WebSocket"];
        try {
          globalAny["location"] = { protocol: "http:", host: "localhost:54321" };
          globalAny["WebSocket"] = function FakeNeverOpenWebSocket() {
            return {
              bufferedAmount: 0,
              send(_data: string) {},
              close() {},
              addEventListener(_event: string, _cb: () => void) {
                // Deliberately never fires "open", "close", or "error".
              },
            };
          };
          return await (fn(arg) as Promise<R>);
        } finally {
          globalAny["location"] = savedLocation;
          globalAny["WebSocket"] = savedWebSocket;
        }
      };

      // deadline=50: FakeClock.nowMs=0 → timeoutMs=50 → openTimer fires after ~50ms.
      // A 400ms race guard catches the case where current code hangs (guard fires first,
      // error has no `kind` property, assertion fails → RED).
      const guardError = new Error("guard: acknowledgeAttentionToken did not reject within time");
      await expect(
        Promise.race([
          surface.acknowledgeAttentionToken("session-abc", "token-xyz", 50),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(guardError), 400)
          ),
        ])
      ).rejects.toMatchObject({ kind: expect.stringMatching(/^(browser|timeout)$/) });

      await surface.close();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("waits for bufferedAmount to drain before closing the WebSocket", async () => {
    // This test proves the evaluate script must NOT call ws.close() while bufferedAmount > 0.
    // FAILS against current code (ws.close() called synchronously after ws.send()).
    // PASSES after the fix (polls bufferedAmount until 0 before closing).
    if (!BrowserDriver) return;
    const log: string[] = [];
    const { driver, surfacePage, workspace } = makeAttentionSurfaceFixture(log);

    try {
      const surface = await driver.createSurface({
        name: "flush-test",
        viewport: { width: 1280, height: 800 },
      });

      let bufferedAmount = 1; // Non-zero: kernel buffer not yet flushed
      const wsEvents: string[] = [];
      let closedWithBufferedAmount = -1;

      surfacePage.evaluateImpl = async <A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> => {
        const listeners: Record<string, Array<() => void>> = {};
        const fakeWs = {
          get bufferedAmount() { return bufferedAmount; },
          send(data: string) { wsEvents.push(`send:${data.substring(0, 20)}`); },
          close() {
            closedWithBufferedAmount = bufferedAmount;
            wsEvents.push("close");
            Promise.resolve().then(() => {
              for (const cb of listeners["close"] ?? []) cb();
            });
          },
          addEventListener(event: string, cb: () => void) {
            (listeners[event] ??= []).push(cb);
          },
        };

        const globalAny = globalThis as Record<string, unknown>;
        const savedLocation = globalAny["location"];
        const savedWebSocket = globalAny["WebSocket"];
        try {
          globalAny["location"] = { protocol: "http:", host: "localhost:54321" };
          globalAny["WebSocket"] = function FakeWebSocketCtor() { return fakeWs; };

          // Drain bufferedAmount to 0 after 15 ms — simulates kernel flush.
          const drainTimer = setTimeout(() => { bufferedAmount = 0; }, 15);
          const result = fn(arg);
          // Trigger "open" on the next microtick so the script's open handler runs.
          await Promise.resolve();
          for (const cb of listeners["open"] ?? []) cb();
          await result;
          clearTimeout(drainTimer);
          return undefined as unknown as R;
        } finally {
          globalAny["location"] = savedLocation;
          globalAny["WebSocket"] = savedWebSocket;
        }
      };

      await surface.acknowledgeAttentionToken("session-abc", "token-xyz", 1_000);

      // After the fix: close must only be called once bufferedAmount has drained to 0.
      expect(closedWithBufferedAmount).toBe(0);
      expect(wsEvents.some((e) => e.startsWith("send:"))).toBe(true);
      expect(wsEvents).toContain("close");

      await surface.close();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects by absolute deadline when close event never fires after send", async () => {
    // FAILS against current code: once ws.open fires the openTimer is cleared; ws.send() runs,
    // tryClose() calls ws.close() synchronously (bufferedAmount === 0), but the close event
    // never fires — the Promise hangs forever because no timer remains active.
    // PASSES after fix: a single deadlineTimer spans all phases and rejects on timeout.
    if (!BrowserDriver) return;
    const log: string[] = [];
    const { driver, surfacePage, workspace } = makeAttentionSurfaceFixture(log);

    try {
      const surface = await driver.createSurface({
        name: "close-hang-test",
        viewport: { width: 1280, height: 800 },
      });

      const wsEvents: string[] = [];

      surfacePage.evaluateImpl = async <A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> => {
        const listeners: Record<string, Array<() => void>> = {};
        const fakeWs = {
          bufferedAmount: 0,
          send(data: string) { wsEvents.push(`send:${data.substring(0, 20)}`); },
          close() {
            wsEvents.push("close-called");
            // Deliberately never emits the "close" event — simulates kernel-level hang.
          },
          addEventListener(event: string, cb: () => void) {
            (listeners[event] ??= []).push(cb);
          },
        };

        const globalAny = globalThis as Record<string, unknown>;
        const savedLocation = globalAny["location"];
        const savedWebSocket = globalAny["WebSocket"];
        try {
          globalAny["location"] = { protocol: "http:", host: "localhost:54321" };
          globalAny["WebSocket"] = function FakeWebSocketCtor() { return fakeWs; };

          const result = fn(arg);
          // Trigger "open" on the next microtick so the open handler runs.
          await Promise.resolve();
          for (const cb of listeners["open"] ?? []) cb();
          return await result;
        } finally {
          globalAny["location"] = savedLocation;
          globalAny["WebSocket"] = savedWebSocket;
        }
      };

      // deadline=100: FakeClock.nowMs=0 → timeoutMs=100 → deadlineTimer fires after ~100 ms.
      // A 800 ms race guard catches the case where current code hangs (guard fires first;
      // the caught error has no `kind` property → assertion fails → RED).
      const guardError = new Error("guard: acknowledgeAttentionToken did not reject within time");
      await expect(
        Promise.race([
          surface.acknowledgeAttentionToken("session-abc", "token-xyz", 100),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(guardError), 800)
          ),
        ])
      ).rejects.toMatchObject({ kind: expect.stringMatching(/^(browser|timeout)$/) });

      // close must have been attempted on the timeout path.
      expect(wsEvents).toContain("close-called");

      await surface.close();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
