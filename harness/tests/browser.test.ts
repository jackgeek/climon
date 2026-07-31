import { describe, expect, test } from "bun:test";
import { HarnessError } from "../src/types.js";

const browserModule = await import("../src/drivers/browser.js").catch(() => null);
const BrowserDriver = (browserModule as { BrowserDriver?: new (...args: any[]) => any } | null)?.BrowserDriver;

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

  public constructor(private readonly log: string[]) {}

  public async start(options: unknown): Promise<void> {
    this.startCalls.push(options);
    this.log.push("trace:start");
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
  public countValue = 1;
  public waitError?: unknown;
  public clickError?: unknown;
  public allInnerTextsValue: string[] = [];
  public attributeValue: string | null = null;
  public attributeValues?: Array<string | null>;

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
    if (this.waitError) {
      throw this.waitError;
    }
  }

  public async click(options?: Record<string, unknown>): Promise<void> {
    this.clickCalls.push(options);
    this.log.push(`click:${this.selector}`);
    if (this.clickError) {
      throw this.clickError;
    }
  }

  public async count(): Promise<number> {
    return this.countValue;
  }

  public async getAttribute(_name: string): Promise<string | null> {
    if (this.attributeValues && this.attributeValues.length > 0) {
      return this.attributeValues.shift() ?? null;
    }
    return this.attributeValue;
  }

  public async allInnerTexts(): Promise<string[]> {
    return this.allInnerTextsValue;
  }
}

class FakePage {
  public readonly keyboard = new FakeKeyboard();
  public readonly locatorCalls: string[] = [];
  public readonly gotoCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
  public closeCalls = 0;
  public gotoError?: unknown;
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

  public constructor(
    private readonly pages: FakePage[],
    log: string[]
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
}

function requireBrowserDriver(): new (...args: any[]) => any {
  expect(BrowserDriver).toBeDefined();
  return BrowserDriver!;
}

function createDriver(options?: {
  clock?: FakeClock;
  pages?: FakePage[];
  log?: string[];
  pollIntervalMs?: number;
}) {
  const log = options?.log ?? [];
  const clock = options?.clock ?? new FakeClock();
  const pages = options?.pages ?? [new FakePage(log)];
  const [page] = pages;
  const context = new FakeBrowserContext(pages.slice(1), log);
  const Driver = requireBrowserDriver();
  const driver = new Driver(
    { context, page },
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

  test("escapes semantic session selectors and opens the terminal surface", async () => {
    const log: string[] = [];
    const page = new FakePage(log);
    page.registerLocator('[data-testid="session-list"]');
    page.registerLocator('[data-testid="session-terminal"]');
    page.registerRoleLocator("button", "Open terminal");
    const { driver } = createDriver({ log, pages: [page] });
    const id = 'quote"slash\\\\tail';

    await driver.open("http://127.0.0.1:43123/", 1_000);
    await driver.openTerminal(id, 1_000);

    expect(page.locatorCalls).toContain(
      '[data-testid="session-item"][data-session-id="quote\\"slash\\\\\\\\tail"]'
    );
    expect(log).toContain(
      'click:[data-testid="session-item"][data-session-id="quote\\"slash\\\\\\\\tail"]'
    );
    expect(log).toContain("click:role=button[name=Open terminal]");
    expect(log).toContain('wait:[data-testid="session-terminal"]');
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
    session.attributeValue = "starting";
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
    expect(error?.message).toContain('currentStatus="starting"');
    expect(error?.message).toContain("warning: terminal websocket lagged");
    expect(error?.message).toContain(
      "http://127.0.0.1:43123/api/sessions :: net::ERR_ABORTED"
    );
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
});
