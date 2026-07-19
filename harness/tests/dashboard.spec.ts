import { expect, test } from "@playwright/test";
import {
  DashboardDriver,
  sessionLocatorSelector,
  validateSessionId,
  validateTerminalLine,
} from "../src/dashboard.js";
import { HarnessError } from "../src/types.js";

// ── Fake Page / Locator stubs ─────────────────────────────────────────────────

interface ConsoleMsg {
  type(): string;
  text(): string;
}

interface Request {
  url(): string;
  failure(): { errorText: string } | null;
}

type LocatorInit = {
  attribute?: string | null;
  textContent?: string | null;
  click?: () => Promise<void>;
  isVisible?: () => Promise<boolean>;
  locator?: (selector: string) => FakeLocator;
  filter?: (opts: { has: FakeLocator }) => FakeLocator;
  waitFor?: (opts: { timeout?: number }) => Promise<void>;
};

class FakeLocator {
  constructor(private readonly _init: LocatorInit = {}) {}
  async getAttribute(_name: string): Promise<string | null> {
    return this._init.attribute ?? null;
  }
  async textContent(): Promise<string | null> {
    return this._init.textContent ?? null;
  }
  async click(): Promise<void> {
    await (this._init.click?.() ?? Promise.resolve());
  }
  async isVisible(): Promise<boolean> {
    return this._init.isVisible?.() ?? false;
  }
  locator(selector: string): FakeLocator {
    return this._init.locator?.(selector) ?? new FakeLocator();
  }
  filter(opts: { has: FakeLocator }): FakeLocator {
    return this._init.filter?.(opts) ?? new FakeLocator();
  }
  async waitFor(opts?: { timeout?: number }): Promise<void> {
    await (this._init.waitFor?.(opts ?? {}) ?? Promise.resolve());
  }
}

type FakePageInit = {
  goto?: (url: string, opts?: unknown) => Promise<void>;
  locator?: (selector: string) => FakeLocator;
  consoleMessages?: ConsoleMsg[];
  failedRequests?: Request[];
  keyboard?: { type: (t: string) => Promise<void>; press: (k: string) => Promise<void> };
};

class FakePage {
  private readonly _consoleMessages: ConsoleMsg[];
  private readonly _failedRequests: Request[];
  private readonly _goto: (url: string, opts?: unknown) => Promise<void>;
  private readonly _locator: (selector: string) => FakeLocator;
  readonly keyboard: { type: (t: string) => Promise<void>; press: (k: string) => Promise<void> };
  private readonly _listeners: Array<(msg: ConsoleMsg) => void> = [];
  private readonly _reqListeners: Array<(req: Request) => void> = [];

  constructor(init: FakePageInit = {}) {
    this._consoleMessages = init.consoleMessages ?? [];
    this._failedRequests = init.failedRequests ?? [];
    this._goto = init.goto ?? (() => Promise.resolve());
    this._locator = init.locator ?? (() => new FakeLocator());
    this.keyboard = init.keyboard ?? {
      type: () => Promise.resolve(),
      press: () => Promise.resolve(),
    };
  }

  async goto(url: string, opts?: unknown): Promise<void> {
    await this._goto(url, opts);
  }

  locator(selector: string): FakeLocator {
    return this._locator(selector);
  }

  on(event: string, cb: (...args: unknown[]) => void): this {
    if (event === "console") this._listeners.push(cb as (msg: ConsoleMsg) => void);
    if (event === "requestfailed") this._reqListeners.push(cb as (req: Request) => void);
    return this;
  }

  /** Emit a fake console event (used in tests) */
  _emitConsole(msg: ConsoleMsg): void {
    this._consoleMessages.push(msg);
    for (const l of this._listeners) l(msg);
  }

  /** Emit a fake requestfailed event */
  _emitRequestFailed(req: Request): void {
    this._failedRequests.push(req);
    for (const l of this._reqListeners) l(req);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("dashboard: session selector safely quotes ID with double quotes", () => {
  const selector = sessionLocatorSelector('say "hello"');
  // Must not contain raw unescaped double quotes inside the attribute value
  expect(selector).toContain('data-session-id');
  // The value should not break the selector (JSON.stringify handles escaping)
  expect(selector).toContain(JSON.stringify('say "hello"'));
});

test("dashboard: session selector safely quotes ID with backslash", () => {
  const selector = sessionLocatorSelector("path\\to\\file");
  expect(selector).toContain('data-session-id');
  expect(selector).toContain(JSON.stringify("path\\to\\file"));
});

test("dashboard: validateSessionId rejects NUL byte", () => {
  expect(() => validateSessionId("abc\x00def")).toThrow(HarnessError);
  expect(() => validateSessionId("abc\x00def")).toThrow("invalid session id");
});

test("dashboard: validateSessionId rejects control characters", () => {
  expect(() => validateSessionId("abc\x1bdef")).toThrow(HarnessError);
});

test("dashboard: validateSessionId accepts normal id", () => {
  expect(() => validateSessionId("session-123_abc")).not.toThrow();
});

test("dashboard: validateTerminalLine rejects line with newline", () => {
  expect(() => validateTerminalLine("line1\nline2")).toThrow(HarnessError);
});

test("dashboard: validateTerminalLine rejects line with CR", () => {
  expect(() => validateTerminalLine("line1\rline2")).toThrow(HarnessError);
});

test("dashboard: validateTerminalLine accepts normal line", () => {
  expect(() => validateTerminalLine("normal line content")).not.toThrow();
});

test("dashboard: captured console messages are accessible", async () => {
  const page = new FakePage();
  // Cast to Page-like type accepted by DashboardDriver
  const driver = new DashboardDriver(page as unknown as import("@playwright/test").Page);

  page._emitConsole({ type: () => "error", text: () => "Something failed" });
  page._emitConsole({ type: () => "log", text: () => "Info message" });

  const msgs = driver.consoleMessages();
  expect(msgs).toHaveLength(2);
  expect(msgs[0]).toContain("error");
  expect(msgs[0]).toContain("Something failed");
  expect(msgs[1]).toContain("log");
  expect(msgs[1]).toContain("Info message");
});

test("dashboard: captured failed requests are accessible", async () => {
  const page = new FakePage();
  const driver = new DashboardDriver(page as unknown as import("@playwright/test").Page);

  page._emitRequestFailed({
    url: () => "http://localhost/api/sessions",
    failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
  });

  const reqs = driver.failedRequests();
  expect(reqs).toHaveLength(1);
  expect(reqs[0]).toContain("http://localhost/api/sessions");
  expect(reqs[0]).toContain("net::ERR_CONNECTION_REFUSED");
});
