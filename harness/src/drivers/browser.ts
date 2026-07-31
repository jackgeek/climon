import type { RuntimeContext } from "../runtime-supervisor.js";
import { HarnessError } from "../types.js";

const SESSION_LIST_SELECTOR = '[data-testid="session-list"]';
const SESSION_ITEM_SELECTOR = '[data-testid="session-item"]';
const SESSION_TERMINAL_SELECTOR = '[data-testid="session-terminal"]';
const SESSION_TERMINAL_READY_ATTRIBUTE = "data-session-id";
const ACCESSIBILITY_ROW_SELECTOR = ".xterm-accessibility-tree > div";
const XTERM_ROW_SELECTOR = ".xterm-rows > div";
const OPEN_TERMINAL_BUTTON_LABEL = "Open terminal";
const ASCII_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;
const ASCII_CONTROL_EXCEPT_LF_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;
const DEFAULT_POLL_INTERVAL_MS = 50;

interface ConsoleMessageLike {
  type(): string;
  text(): string;
}

interface RequestFailureLike {
  errorText?: string;
}

interface RequestLike {
  url(): string;
  failure(): RequestFailureLike | null;
}

interface LocatorLike {
  locator(selector: string): LocatorLike;
  getByRole(role: string, options: { name: string }): LocatorLike;
  waitFor(options?: { state?: "attached" | "visible"; timeout?: number }): Promise<void>;
  click(options?: { timeout?: number }): Promise<void>;
  count(): Promise<number>;
  getAttribute(name: string, options?: { timeout?: number }): Promise<string | null>;
  allInnerTexts(): Promise<string[]>;
}

interface KeyboardLike {
  insertText(text: string): Promise<void>;
  press(key: string): Promise<void>;
}

interface PageLike {
  locator(selector: string): LocatorLike;
  getByRole(role: string, options: { name: string }): LocatorLike;
  goto(url: string, options: { timeout?: number; waitUntil?: "domcontentloaded" }): Promise<unknown>;
  close(): Promise<unknown>;
  on(event: "console", listener: (message: ConsoleMessageLike) => void): void;
  on(event: "requestfailed", listener: (request: RequestLike) => void): void;
  keyboard: KeyboardLike;
}

interface BrowserContextLike {
  tracing: {
    start(options?: { screenshots?: boolean; snapshots?: boolean }): Promise<void>;
    stop(options: { path: string }): Promise<void>;
  };
  newPage(): Promise<PageLike>;
}

const tracedContexts = new WeakSet<BrowserContextLike>();

export async function stopBrowserTracing(context: BrowserContextLike, path: string): Promise<void> {
  if (!tracedContexts.has(context)) {
    return;
  }

  await context.tracing.stop({ path });
  tracedContexts.delete(context);
}

type BrowserRuntime = Pick<RuntimeContext, "context" | "page"> & {
  context: BrowserContextLike;
  page: PageLike;
};

export interface BrowserDriverDependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

function assertAbsoluteDeadline(deadline: number): void {
  if (!Number.isFinite(deadline) || deadline <= 0) {
    throw new HarnessError("prerequisite", "deadline must be a positive absolute timestamp");
  }
}

function assertToken(label: string, value: string): string {
  if (value.length === 0) {
    throw new HarnessError("prerequisite", `${label} must not be empty`);
  }
  if (ASCII_CONTROL_RE.test(value)) {
    throw new HarnessError("prerequisite", `${label} must not contain ASCII control characters`);
  }
  return value;
}

function assertTerminalText(text: string): string {
  if (text.length === 0) {
    throw new HarnessError("prerequisite", "text must not be empty");
  }
  if (text.includes("\r") || ASCII_CONTROL_EXCEPT_LF_RE.test(text)) {
    throw new HarnessError("prerequisite", "text must not contain carriage returns or ASCII control characters");
  }
  return text;
}

function assertTerminalLine(text: string): string {
  if (text.length === 0) {
    throw new HarnessError("prerequisite", "text must not be empty");
  }
  if (ASCII_CONTROL_RE.test(text)) {
    throw new HarnessError("prerequisite", "text must not contain carriage returns, line feeds, or ASCII control characters");
  }
  return text;
}

function escapeCssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function sessionSelector(id: string): string {
  return `${SESSION_ITEM_SELECTOR}[data-session-id="${escapeCssString(assertToken("id", id))}"]`;
}

function sessionTerminalReadySelector(id: string): string {
  return `${SESSION_TERMINAL_SELECTOR}[${SESSION_TERMINAL_READY_ATTRIBUTE}="${escapeCssString(assertToken("id", id))}"]`;
}

function normalizeBaseUrl(baseUrl: string): string {
  return new URL(baseUrl).toString();
}

function isTimeoutError(error: unknown): error is Error {
  return error instanceof Error && error.name === "TimeoutError";
}

function joinRowText(rows: string[]): string {
  const visibleRows = [...rows];
  while (visibleRows.length > 0 && visibleRows.at(-1) === "") {
    visibleRows.pop();
  }
  return visibleRows.join("\n");
}

export class BrowserDriver {
  private readonly context: BrowserContextLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly attachedPages = new Set<PageLike>();
  private readonly consoleHistory: string[] = [];
  private readonly requestFailureHistory: string[] = [];
  private page: PageLike | null;

  public constructor(runtime: BrowserRuntime, dependencies: BrowserDriverDependencies = {}) {
    this.context = runtime.context;
    this.page = runtime.page;
    this.now = dependencies.now ?? (() => Date.now());
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.attachPage(runtime.page);
  }

  public async open(baseUrl: string, deadline: number): Promise<void> {
    assertAbsoluteDeadline(deadline);
    const url = normalizeBaseUrl(baseUrl);
    const page = this.requirePage();
    const diagnostics = { selector: SESSION_LIST_SELECTOR, url };

    try {
      await this.startTracing();
      await page.goto(url, {
        timeout: this.remainingMs(deadline, () => this.timeoutError("dashboard open", diagnostics)),
        waitUntil: "domcontentloaded"
      });
      await page.locator(SESSION_LIST_SELECTOR).waitFor({
        state: "visible",
        timeout: this.remainingMs(deadline, () => this.timeoutError("dashboard open", diagnostics))
      });
    } catch (error) {
      this.throwTranslatedError("dashboard open", error, diagnostics);
    }
  }

  public async waitForSessionStatus(id: string, status: string, deadline: number): Promise<void> {
    assertAbsoluteDeadline(deadline);
    const selector = sessionSelector(id);
    const targetStatus = assertToken("status", status);
    const page = this.requirePage();
    const sessionItem = page.locator(selector);
    let currentStatus: string | null = null;
    const diagnostics = () => ({
      selector,
      id: JSON.stringify(id),
      expectedStatus: JSON.stringify(targetStatus),
      currentStatus: JSON.stringify(currentStatus)
    });

    while (true) {
      const timeoutMs = this.remainingMs(deadline, () => this.timeoutError("session status", diagnostics()));
      try {
        currentStatus = await sessionItem.getAttribute("data-session-status", { timeout: timeoutMs });
      } catch (error) {
        this.throwTranslatedError("session status", error, diagnostics());
      }

      if (currentStatus === targetStatus) {
        return;
      }

      if (this.now() >= deadline) {
        throw this.timeoutError("session status", diagnostics());
      }

      await this.sleep(Math.max(1, Math.min(this.pollIntervalMs, deadline - this.now())));
    }
  }

  public async openTerminal(id: string, deadline: number): Promise<void> {
    assertAbsoluteDeadline(deadline);
    const requestedSessionId = assertToken("id", id);
    const selector = sessionSelector(id);
    const page = this.requirePage();
    const sessionItem = page.locator(selector);
    const readySelector = sessionTerminalReadySelector(requestedSessionId);
    const terminal = page.locator(SESSION_TERMINAL_SELECTOR);
    const readyTerminal = page.locator(readySelector);
    const openButton = sessionItem.getByRole("button", { name: OPEN_TERMINAL_BUTTON_LABEL });
    let currentReadySessionId: string | null = null;
    const diagnostics = () => ({
      selector,
      readySelector,
      terminalSelector: SESSION_TERMINAL_SELECTOR,
      requestedSessionId: JSON.stringify(requestedSessionId),
      currentReadySessionId: JSON.stringify(currentReadySessionId)
    });

    try {
      await sessionItem.click({
        timeout: this.remainingMs(deadline, () => this.timeoutError("terminal open", diagnostics()))
      });
      let openButtonClicked = false;

      while (true) {
        const timeoutMs = this.remainingMs(deadline, () => this.timeoutError("terminal open", diagnostics()));
        const pollTimeoutMs = Math.max(1, Math.min(this.pollIntervalMs, timeoutMs));
        try {
          await readyTerminal.waitFor({
            state: "visible",
            timeout: pollTimeoutMs
          });
          return;
        } catch (error) {
          if (!isTimeoutError(error)) {
            throw error;
          }
        }

        try {
          currentReadySessionId = await terminal.getAttribute(SESSION_TERMINAL_READY_ATTRIBUTE, {
            timeout: pollTimeoutMs
          });
        } catch {
          currentReadySessionId = null;
        }

        if (!openButtonClicked && (await openButton.count()) > 0) {
          await openButton.click({
            timeout: this.remainingMs(deadline, () => this.timeoutError("terminal open", diagnostics()))
          });
          openButtonClicked = true;
          continue;
        }

        await this.sleep(Math.max(1, Math.min(this.pollIntervalMs, deadline - this.now())));
      }
    } catch (error) {
      this.throwTranslatedError("terminal open", error, diagnostics());
    }
  }

  public async waitForTerminalText(text: string, deadline: number): Promise<void> {
    assertAbsoluteDeadline(deadline);
    const targetText = assertTerminalText(text);
    const page = this.requirePage();
    const terminal = page.locator(SESSION_TERMINAL_SELECTOR);

    try {
      await terminal.waitFor({
        state: "visible",
        timeout: this.remainingMs(deadline, () =>
          this.timeoutError("terminal text", {
            selector: SESSION_TERMINAL_SELECTOR,
            expectedText: JSON.stringify(targetText)
          })
        )
      });
    } catch (error) {
      this.throwTranslatedError("terminal text", error, {
        selector: SESSION_TERMINAL_SELECTOR,
        expectedText: JSON.stringify(targetText)
      });
    }

    let currentText = "";
    while (true) {
      try {
        currentText = await this.readTerminalText(terminal);
      } catch (error) {
        this.throwTranslatedError("terminal text", error, {
          selector: SESSION_TERMINAL_SELECTOR,
          expectedText: JSON.stringify(targetText),
          currentText: JSON.stringify(currentText)
        });
      }

      if (currentText.includes(targetText)) {
        return;
      }

      if (this.now() >= deadline) {
        throw this.timeoutError("terminal text", {
          selector: SESSION_TERMINAL_SELECTOR,
          expectedText: JSON.stringify(targetText),
          currentText: JSON.stringify(currentText)
        });
      }

      await this.sleep(Math.max(1, Math.min(this.pollIntervalMs, deadline - this.now())));
    }
  }

  public async sendTerminalLine(text: string): Promise<void> {
    const line = assertTerminalLine(text);
    const page = this.requirePage();
    const diagnostics = { selector: SESSION_TERMINAL_SELECTOR, text: JSON.stringify(line) };

    try {
      await page.locator(SESSION_TERMINAL_SELECTOR).click();
      await page.keyboard.insertText(line);
      await page.keyboard.press("Enter");
    } catch (error) {
      this.throwTranslatedError("terminal input", error, diagnostics);
    }
  }

  public async closeViewer(): Promise<void> {
    if (!this.page) {
      return;
    }

    await this.page.close();
    this.page = null;
  }

  public async reopenViewer(baseUrl: string, deadline: number): Promise<void> {
    assertAbsoluteDeadline(deadline);
    try {
      const page = await this.context.newPage();
      this.attachPage(page);
      this.page = page;
    } catch (error) {
      this.throwTranslatedError("viewer reopen", error, { url: normalizeBaseUrl(baseUrl) });
    }

    await this.open(baseUrl, deadline);
  }

  public consoleMessages(): string[] {
    return [...this.consoleHistory];
  }

  public failedRequests(): string[] {
    return [...this.requestFailureHistory];
  }

  private attachPage(page: PageLike): void {
    if (this.attachedPages.has(page)) {
      return;
    }

    page.on("console", (message) => {
      this.consoleHistory.push(`${message.type()}: ${message.text()}`);
    });
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText ?? "request failed";
      this.requestFailureHistory.push(`${request.url()} :: ${failure}`);
    });
    this.attachedPages.add(page);
  }

  private async startTracing(): Promise<void> {
    if (tracedContexts.has(this.context)) {
      return;
    }

    await this.context.tracing.start({ screenshots: true, snapshots: true });
    tracedContexts.add(this.context);
  }

  private async readTerminalText(terminal: LocatorLike): Promise<string> {
    const accessibilityText = joinRowText(
      await terminal.locator(ACCESSIBILITY_ROW_SELECTOR).allInnerTexts()
    );
    if (accessibilityText.length > 0) {
      return accessibilityText;
    }

    return joinRowText(await terminal.locator(XTERM_ROW_SELECTOR).allInnerTexts());
  }

  private requirePage(): PageLike {
    if (!this.page) {
      throw new HarnessError("browser", "Viewer page is closed");
    }

    return this.page;
  }

  private remainingMs(deadline: number, onElapsed: () => HarnessError): number {
    const remainingMs = Math.ceil(deadline - this.now());
    if (remainingMs <= 0) {
      throw onElapsed();
    }

    return remainingMs;
  }

  private timeoutError(
    label: string,
    diagnostics: Record<string, string | undefined>
  ): HarnessError {
    return new HarnessError("timeout", `Timed out waiting for ${label}; ${this.formatDiagnostics(diagnostics)}`);
  }

  private throwTranslatedError(
    label: string,
    error: unknown,
    diagnostics: Record<string, string | undefined>
  ): never {
    if (error instanceof HarnessError) {
      throw error;
    }
    if (isTimeoutError(error)) {
      throw new HarnessError("timeout", `Timed out waiting for ${label}; ${this.formatDiagnostics(diagnostics)}`, {
        cause: error
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new HarnessError("browser", `Browser driver ${label} failed: ${message}`, {
      cause: error
    });
  }

  private formatDiagnostics(diagnostics: Record<string, string | undefined>): string {
    const parts = Object.entries(diagnostics)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`);
    if (this.consoleHistory.length > 0) {
      parts.push(`console=${JSON.stringify(this.consoleHistory)}`);
    }
    if (this.requestFailureHistory.length > 0) {
      parts.push(`network=${JSON.stringify(this.requestFailureHistory)}`);
    }
    return parts.join("; ");
  }
}
