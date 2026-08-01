import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HarnessError } from "../types.js";

const SESSION_LIST_SELECTOR = '[data-testid="session-list"]';
const SESSION_ITEM_SELECTOR = '[data-testid="session-item"]';
const SESSION_TERMINAL_SELECTOR = '[data-testid="session-terminal"]';
const SESSION_TERMINAL_READY_ATTRIBUTE = "data-session-id";
const CONTROLLER_ID_ATTRIBUTE = "data-controller-id";
const TERMINAL_TITLE_ATTRIBUTE = "data-terminal-title";
const PROGRESS_STATE_ATTRIBUTE = "data-progress-state";
const PROGRESS_PERCENT_ATTRIBUTE = "data-progress-percent";
const ACCESSIBILITY_ROW_SELECTOR = ".xterm-accessibility-tree > div";
const XTERM_ROW_SELECTOR = ".xterm-rows > div";
const OPEN_TERMINAL_BUTTON_LABEL = "Open terminal";
const TAKE_CONTROL_BUTTON_LABEL = "Take control";
const ASCII_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;
const ASCII_CONTROL_EXCEPT_LF_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_DISPLAY_MODE = "browser";

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
  setViewportSize?(viewport: { width: number; height: number }): Promise<unknown>;
  screenshot?(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  keyboard: KeyboardLike;
}

interface BrowserContextLike {
  tracing: {
    start(options?: { screenshots?: boolean; snapshots?: boolean }): Promise<void>;
    stop(options: { path: string }): Promise<void>;
  };
  newPage(): Promise<PageLike>;
  close(): Promise<unknown>;
  addInitScript?(script: (arg: { viewerId: string; displayMode: BrowserSurfaceDisplayMode }) => void, arg: {
    viewerId: string;
    displayMode: BrowserSurfaceDisplayMode;
  }): Promise<unknown>;
}

interface BrowserLike {
  newContext(options?: { viewport?: { width: number; height: number } }): Promise<BrowserContextLike>;
  close(): Promise<unknown>;
}

const tracedContexts = new WeakSet<BrowserContextLike>();

export async function stopBrowserTracing(context: BrowserContextLike, path: string): Promise<void> {
  if (!tracedContexts.has(context)) {
    return;
  }

  await context.tracing.stop({ path });
  tracedContexts.delete(context);
}

export type BrowserSurfaceDisplayMode = "browser" | "standalone";

export interface BrowserSurfaceOptions {
  name: string;
  viewport: { width: number; height: number };
  displayMode?: BrowserSurfaceDisplayMode;
}

export interface BrowserSurfaceProgress {
  state: string | null;
  percent: number | null;
}

export interface BrowserSurface {
  readonly name: string;
  readonly viewerId: string;
  open(baseUrl: string, deadline: number): Promise<void>;
  openTerminal(id: string, deadline: number): Promise<void>;
  takeControl(id: string, deadline: number): Promise<void>;
  controllerId(id: string, deadline: number): Promise<string>;
  acknowledgeAttention(id: string, deadline: number): Promise<void>;
  resizeViewport(width: number, height: number): Promise<void>;
  terminalText(): Promise<string>;
  status(id: string, deadline: number): Promise<string | null>;
  title(id: string, deadline: number): Promise<string>;
  progress(id: string, deadline: number): Promise<BrowserSurfaceProgress>;
  consoleMessages(): string[];
  failedRequests(): string[];
  close(): Promise<void>;
}

interface BrowserSurfaceRecord {
  name: string;
  viewerId: string;
  context: BrowserContextLike;
  page: PageLike;
  tracePath: string;
  screenshotPath: string;
  consolePath: string;
  failedRequestsPath: string;
  consoleHistory: string[];
  requestFailureHistory: string[];
  closed: boolean;
}

export class BrowserSurfaceRegistry {
  private readonly records = new Map<string, BrowserSurfaceRecord>();
  private sequence = 0;

  public constructor(private readonly args: { browser: BrowserLike; artifactsDir: string }) {}

  public async create(options: BrowserSurfaceOptions): Promise<BrowserSurfaceRecord> {
    const name = assertSurfaceName(options.name);
    if (this.records.has(name)) {
      throw new HarnessError("prerequisite", `Browser surface ${JSON.stringify(name)} already exists`);
    }

    const viewport = normalizeViewport(options.viewport);
    const displayMode = options.displayMode ?? DEFAULT_DISPLAY_MODE;
    const sequence = this.sequence + 1;
    const slug = surfaceSlug(name);
    const viewerId = `surface-${sequence}-${slug}`;
    const artifactsDir = join(this.args.artifactsDir, "browser-surfaces", `${String(sequence).padStart(2, "0")}-${slug}`);
    let context: BrowserContextLike | undefined;
    let page: PageLike | undefined;

    try {
      context = await this.args.browser.newContext({ viewport });
      await context.addInitScript?.(browserSurfaceInitScript, { viewerId, displayMode });
      page = await context.newPage();

      const record: BrowserSurfaceRecord = {
        name,
        viewerId,
        context,
        page,
        tracePath: join(artifactsDir, "trace.zip"),
        screenshotPath: join(artifactsDir, "closing.png"),
        consolePath: join(artifactsDir, "console.log"),
        failedRequestsPath: join(artifactsDir, "failed-requests.log"),
        consoleHistory: [],
        requestFailureHistory: [],
        closed: false,
      };
      this.sequence = sequence;
      this.records.set(name, record);
      return record;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (page) {
        try {
          await page.close();
        } catch (closeError) {
          cleanupErrors.push(closeError);
        }
      }
      if (context) {
        try {
          await context.close();
        } catch (closeError) {
          cleanupErrors.push(closeError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], `Failed to create browser surface ${name}`);
      }
      throw error;
    }
  }

  public async close(record: BrowserSurfaceRecord): Promise<void> {
    if (record.closed) {
      return;
    }

    const errors: unknown[] = [];
    try {
      await stopBrowserTracing(record.context, record.tracePath);
    } catch (error) {
      errors.push(error);
    }

    try {
      await this.persistSurfaceEvidence(record);
    } catch (error) {
      errors.push(error);
    }

    if (typeof record.page.screenshot === "function") {
      try {
        await mkdir(dirname(record.screenshotPath), { recursive: true });
        await record.page.screenshot({ path: record.screenshotPath, fullPage: true });
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      await record.page.close();
    } catch (error) {
      errors.push(error);
    }

    try {
      await record.context.close();
    } catch (error) {
      errors.push(error);
    }

    record.closed = true;

    if (errors.length > 0) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, `Failed to close browser surface ${record.name}`);
    }
  }

  public async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const record of this.records.values()) {
      try {
        await this.close(record);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Failed to close browser surfaces");
    }
  }

  private async persistSurfaceEvidence(record: BrowserSurfaceRecord): Promise<void> {
    await Promise.all([
      writeTextFile(record.consolePath, joinHistory(record.consoleHistory)),
      writeTextFile(record.failedRequestsPath, joinHistory(record.requestFailureHistory)),
    ]);
  }
}

interface BrowserRuntime {
  context: BrowserContextLike;
  page: PageLike;
  browser?: BrowserLike;
  artifacts?: { dir: string };
  browserSurfaceRegistry?: BrowserSurfaceRegistry;
}

export interface BrowserDriverDependencies {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

interface SurfaceDependencies extends Required<BrowserDriverDependencies> {}

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

function assertSurfaceName(value: string): string {
  const name = assertToken("surface name", value.trim());
  return name;
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

function normalizeViewport(viewport: { width: number; height: number }): { width: number; height: number } {
  const width = Math.floor(viewport.width);
  const height = Math.floor(viewport.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new HarnessError("prerequisite", "viewport dimensions must be positive integers");
  }
  return { width, height };
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

function joinHistory(entries: string[]): string {
  return entries.length === 0 ? "" : `${entries.join("\n")}\n`;
}

async function writeTextFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

function surfaceSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "surface";
}

function browserSurfaceInitScript(args: { viewerId: string; displayMode: BrowserSurfaceDisplayMode }): void {
  const { viewerId, displayMode } = args;
  const standalone = displayMode === "standalone";
  const globalObject = globalThis as typeof globalThis & {
    crypto?: Crypto;
    navigator?: Navigator & { standalone?: boolean };
  };
  const cryptoObject = globalObject.crypto;

  try {
    if (cryptoObject) {
      Object.defineProperty(cryptoObject, "randomUUID", {
        configurable: true,
        value: () => viewerId,
      });
    }
  } catch {
    // Ignore read-only browser shims.
  }

  if (typeof window === "undefined") {
    return;
  }

  const fallback = (query: string, matches: boolean): MediaQueryList => ({
    matches,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  });

  const originalMatchMedia = typeof window.matchMedia === "function"
    ? window.matchMedia.bind(window)
    : undefined;
  window.matchMedia = (query: string): MediaQueryList => {
    if (query === "(display-mode: standalone)") {
      return fallback(query, standalone);
    }
    return originalMatchMedia?.(query) ?? fallback(query, false);
  };

  try {
    Object.defineProperty(window.navigator, "standalone", {
      configurable: true,
      get: () => standalone,
    });
  } catch {
    // Ignore browsers where this property cannot be redefined.
  }
}

class BrowserSurfaceSession implements BrowserSurface {
  public readonly name: string;
  public readonly viewerId: string;
  private readonly attachedPages = new Set<PageLike>();
  private page: PageLike | null;

  public constructor(
    private readonly args: {
      name: string;
      viewerId: string;
      context: BrowserContextLike;
      page: PageLike;
      consoleHistory: string[];
      requestFailureHistory: string[];
      onClose?: () => Promise<void>;
    },
    private readonly dependencies: SurfaceDependencies,
  ) {
    this.name = args.name;
    this.viewerId = args.viewerId;
    this.page = args.page;
    this.attachPage(args.page);
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
        waitUntil: "domcontentloaded",
      });
      await page.locator(SESSION_LIST_SELECTOR).waitFor({
        state: "visible",
        timeout: this.remainingMs(deadline, () => this.timeoutError("dashboard open", diagnostics)),
      });
    } catch (error) {
      this.throwTranslatedError("dashboard open", error, diagnostics);
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
      currentReadySessionId: JSON.stringify(currentReadySessionId),
    });

    try {
      await sessionItem.click({
        timeout: this.remainingMs(deadline, () => this.timeoutError("terminal open", diagnostics())),
      });
      let openButtonClicked = false;

      while (true) {
        const timeoutMs = this.remainingMs(deadline, () => this.timeoutError("terminal open", diagnostics()));
        const pollTimeoutMs = Math.max(1, Math.min(this.dependencies.pollIntervalMs, timeoutMs));
        try {
          await readyTerminal.waitFor({
            state: "visible",
            timeout: pollTimeoutMs,
          });
          return;
        } catch (error) {
          if (!isTimeoutError(error)) {
            throw error;
          }
        }

        try {
          currentReadySessionId = await terminal.getAttribute(SESSION_TERMINAL_READY_ATTRIBUTE, {
            timeout: pollTimeoutMs,
          });
        } catch {
          currentReadySessionId = null;
        }

        if (!openButtonClicked && (await openButton.count()) > 0) {
          await openButton.click({
            timeout: this.remainingMs(deadline, () => this.timeoutError("terminal open", diagnostics())),
          });
          openButtonClicked = true;
          continue;
        }

        await this.dependencies.sleep(Math.max(1, Math.min(this.dependencies.pollIntervalMs, deadline - this.dependencies.now())));
      }
    } catch (error) {
      this.throwTranslatedError("terminal open", error, diagnostics());
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
      currentStatus: JSON.stringify(currentStatus),
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

      if (this.dependencies.now() >= deadline) {
        throw this.timeoutError("session status", diagnostics());
      }

      await this.dependencies.sleep(Math.max(1, Math.min(this.dependencies.pollIntervalMs, deadline - this.dependencies.now())));
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
            expectedText: JSON.stringify(targetText),
          })
        ),
      });
    } catch (error) {
      this.throwTranslatedError("terminal text", error, {
        selector: SESSION_TERMINAL_SELECTOR,
        expectedText: JSON.stringify(targetText),
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
          currentText: JSON.stringify(currentText),
        });
      }

      if (currentText.includes(targetText)) {
        return;
      }

      if (this.dependencies.now() >= deadline) {
        throw this.timeoutError("terminal text", {
          selector: SESSION_TERMINAL_SELECTOR,
          expectedText: JSON.stringify(targetText),
          currentText: JSON.stringify(currentText),
        });
      }

      await this.dependencies.sleep(Math.max(1, Math.min(this.dependencies.pollIntervalMs, deadline - this.dependencies.now())));
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

  public async terminalText(): Promise<string> {
    const page = this.requirePage();
    const terminal = page.locator(SESSION_TERMINAL_SELECTOR);

    try {
      return await this.readTerminalText(terminal);
    } catch (error) {
      this.throwTranslatedError("terminal snapshot", error, {
        selector: SESSION_TERMINAL_SELECTOR,
      });
    }
  }

  public async controllerId(id: string, deadline: number): Promise<string> {
    assertAbsoluteDeadline(deadline);
    const readySelector = sessionTerminalReadySelector(id);
    const readyTerminal = this.requirePage().locator(readySelector);
    let currentControllerId: string | null = null;
    const diagnostics = () => ({
      readySelector,
      expectedControllerId: JSON.stringify(this.viewerId),
      currentControllerId: JSON.stringify(currentControllerId),
    });

    try {
      await readyTerminal.waitFor({
        state: "visible",
        timeout: this.remainingMs(deadline, () => this.timeoutError("controller id", diagnostics())),
      });
    } catch (error) {
      this.throwTranslatedError("controller id", error, diagnostics());
    }

    while (true) {
      try {
        currentControllerId = await readyTerminal.getAttribute(CONTROLLER_ID_ATTRIBUTE, {
          timeout: this.remainingMs(deadline, () => this.timeoutError("controller id", diagnostics())),
        });
      } catch (error) {
        this.throwTranslatedError("controller id", error, diagnostics());
      }

      if (currentControllerId && currentControllerId.length > 0) {
        return currentControllerId;
      }
      if (this.dependencies.now() >= deadline) {
        throw this.timeoutError("controller id", diagnostics());
      }
      await this.dependencies.sleep(Math.max(1, Math.min(this.dependencies.pollIntervalMs, deadline - this.dependencies.now())));
    }
  }

  public async takeControl(id: string, deadline: number): Promise<void> {
    assertAbsoluteDeadline(deadline);
    const page = this.requirePage();
    const button = page.getByRole("button", { name: TAKE_CONTROL_BUTTON_LABEL });
    try {
      if ((await button.count()) > 0) {
        await button.click({
          timeout: this.remainingMs(deadline, () => this.timeoutError("take control", { id: JSON.stringify(id) })),
        });
      }
      await this.waitForController(id, this.viewerId, deadline);
    } catch (error) {
      this.throwTranslatedError("take control", error, { id: JSON.stringify(id) });
    }
  }

  public async acknowledgeAttention(id: string, deadline: number): Promise<void> {
    assertAbsoluteDeadline(deadline);
    const selector = sessionSelector(id);
    const sessionItem = this.requirePage().locator(selector);
    let currentStatus: string | null = null;
    const diagnostics = () => ({
      selector,
      id: JSON.stringify(id),
      currentStatus: JSON.stringify(currentStatus),
    });

    try {
      await sessionItem.click({
        timeout: this.remainingMs(deadline, () => this.timeoutError("attention acknowledgement", diagnostics())),
      });
    } catch (error) {
      this.throwTranslatedError("attention acknowledgement", error, diagnostics());
    }

    while (true) {
      try {
        currentStatus = await sessionItem.getAttribute("data-session-status", {
          timeout: this.remainingMs(deadline, () => this.timeoutError("attention acknowledgement", diagnostics())),
        });
      } catch (error) {
        this.throwTranslatedError("attention acknowledgement", error, diagnostics());
      }

      if (currentStatus !== "needs-attention") {
        return;
      }
      if (this.dependencies.now() >= deadline) {
        throw this.timeoutError("attention acknowledgement", diagnostics());
      }
      await this.dependencies.sleep(Math.max(1, Math.min(this.dependencies.pollIntervalMs, deadline - this.dependencies.now())));
    }
  }

  public async resizeViewport(width: number, height: number): Promise<void> {
    const page = this.requirePage();
    const viewport = normalizeViewport({ width, height });
    if (typeof page.setViewportSize !== "function") {
      throw new HarnessError("browser", `Browser surface ${this.name} cannot resize its viewport`);
    }
    try {
      await page.setViewportSize(viewport);
    } catch (error) {
      this.throwTranslatedError("viewport resize", error, {
        width: String(viewport.width),
        height: String(viewport.height),
      });
    }
  }

  public async status(id: string, deadline: number): Promise<string | null> {
    return this.readSessionAttribute(id, "session status snapshot", "data-session-status", deadline);
  }

  public async title(id: string, deadline: number): Promise<string> {
    return (await this.readSessionAttribute(id, "terminal title snapshot", TERMINAL_TITLE_ATTRIBUTE, deadline)) ?? "";
  }

  public async progress(id: string, deadline: number): Promise<BrowserSurfaceProgress> {
    const state = await this.readSessionAttribute(id, "progress state snapshot", PROGRESS_STATE_ATTRIBUTE, deadline);
    const percentRaw = await this.readSessionAttribute(id, "progress percent snapshot", PROGRESS_PERCENT_ATTRIBUTE, deadline);
    const percent = percentRaw && percentRaw.length > 0 ? Number(percentRaw) : null;
    return {
      state: state && state.length > 0 ? state : null,
      percent: percent !== null && Number.isFinite(percent) ? percent : null,
    };
  }

  public consoleMessages(): string[] {
    return [...this.args.consoleHistory];
  }

  public failedRequests(): string[] {
    return [...this.args.requestFailureHistory];
  }

  public async close(): Promise<void> {
    if (!this.page) {
      return;
    }
    if (this.args.onClose) {
      await this.args.onClose();
    } else {
      await this.page.close();
    }
    this.page = null;
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
      const page = await this.args.context.newPage();
      this.attachPage(page);
      this.page = page;
      this.args.page = page;
    } catch (error) {
      this.throwTranslatedError("viewer reopen", error, { url: normalizeBaseUrl(baseUrl) });
    }

    await this.open(baseUrl, deadline);
  }

  private attachPage(page: PageLike): void {
    if (this.attachedPages.has(page)) {
      return;
    }

    page.on("console", (message) => {
      this.args.consoleHistory.push(`${message.type()}: ${message.text()}`);
    });
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText ?? "request failed";
      this.args.requestFailureHistory.push(`${request.url()} :: ${failure}`);
    });
    this.attachedPages.add(page);
  }

  private async startTracing(): Promise<void> {
    if (tracedContexts.has(this.args.context)) {
      return;
    }

    await this.args.context.tracing.start({ screenshots: true, snapshots: true });
    tracedContexts.add(this.args.context);
  }

  private async waitForController(id: string, expectedControllerId: string, deadline: number): Promise<void> {
    let currentControllerId: string | null = null;
    const diagnostics = () => ({
      id: JSON.stringify(id),
      expectedControllerId: JSON.stringify(expectedControllerId),
      currentControllerId: JSON.stringify(currentControllerId),
    });

    while (true) {
      currentControllerId = await this.controllerId(id, deadline);
      if (currentControllerId === expectedControllerId) {
        return;
      }
      if (this.dependencies.now() >= deadline) {
        throw this.timeoutError("controller handoff", diagnostics());
      }
      await this.dependencies.sleep(Math.max(1, Math.min(this.dependencies.pollIntervalMs, deadline - this.dependencies.now())));
    }
  }

  private async readSessionAttribute(
    id: string,
    label: string,
    attribute: string,
    deadline: number,
  ): Promise<string | null> {
    assertAbsoluteDeadline(deadline);
    const selector = sessionSelector(id);
    const sessionItem = this.requirePage().locator(selector);
    const diagnostics = () => ({ selector, id: JSON.stringify(id), attribute });

    try {
      return await sessionItem.getAttribute(attribute, {
        timeout: this.remainingMs(deadline, () => this.timeoutError(label, diagnostics())),
      });
    } catch (error) {
      this.throwTranslatedError(label, error, diagnostics());
    }
  }

  private async readTerminalText(terminal: LocatorLike): Promise<string> {
    const accessibilityText = joinRowText(await terminal.locator(ACCESSIBILITY_ROW_SELECTOR).allInnerTexts());
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
    const remainingMs = Math.ceil(deadline - this.dependencies.now());
    if (remainingMs <= 0) {
      throw onElapsed();
    }

    return remainingMs;
  }

  private timeoutError(label: string, diagnostics: Record<string, string | undefined>): HarnessError {
    return new HarnessError("timeout", `Timed out waiting for ${label}; ${this.formatDiagnostics(diagnostics)}`);
  }

  private throwTranslatedError(
    label: string,
    error: unknown,
    diagnostics: Record<string, string | undefined>,
  ): never {
    if (error instanceof HarnessError) {
      throw error;
    }
    if (isTimeoutError(error)) {
      throw new HarnessError("timeout", `Timed out waiting for ${label}; ${this.formatDiagnostics(diagnostics)}`, {
        cause: error,
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new HarnessError("browser", `Browser driver ${label} failed: ${message}`, {
      cause: error,
    });
  }

  private formatDiagnostics(diagnostics: Record<string, string | undefined>): string {
    const parts = Object.entries(diagnostics)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`);
    if (this.args.consoleHistory.length > 0) {
      parts.push(`console=${JSON.stringify(this.args.consoleHistory)}`);
    }
    if (this.args.requestFailureHistory.length > 0) {
      parts.push(`network=${JSON.stringify(this.args.requestFailureHistory)}`);
    }
    return parts.join("; ");
  }
}

export class BrowserDriver {
  private readonly runtime: BrowserRuntime;
  private readonly primary: BrowserSurfaceSession;
  private readonly dependencies: SurfaceDependencies;

  public constructor(runtime: BrowserRuntime, dependencies: BrowserDriverDependencies = {}) {
    this.runtime = runtime;
    this.dependencies = {
      now: dependencies.now ?? (() => Date.now()),
      sleep: dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      pollIntervalMs: dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    };
    this.primary = new BrowserSurfaceSession(
      {
        name: "primary",
        viewerId: "primary",
        context: runtime.context,
        page: runtime.page,
        consoleHistory: [],
        requestFailureHistory: [],
      },
      this.dependencies,
    );
  }

  public async createSurface(options: BrowserSurfaceOptions): Promise<BrowserSurface> {
    const registry = this.ensureSurfaceRegistry();
    const record = await registry.create(options);
    return new BrowserSurfaceSession(
      {
        name: record.name,
        viewerId: record.viewerId,
        context: record.context,
        page: record.page,
        consoleHistory: record.consoleHistory,
        requestFailureHistory: record.requestFailureHistory,
        onClose: async () => {
          await registry.close(record);
        },
      },
      this.dependencies,
    );
  }

  public async open(baseUrl: string, deadline: number): Promise<void> {
    await this.primary.open(baseUrl, deadline);
  }

  public async waitForSessionStatus(id: string, status: string, deadline: number): Promise<void> {
    await this.primary.waitForSessionStatus(id, status, deadline);
  }

  public async openTerminal(id: string, deadline: number): Promise<void> {
    await this.primary.openTerminal(id, deadline);
  }

  public async waitForTerminalText(text: string, deadline: number): Promise<void> {
    await this.primary.waitForTerminalText(text, deadline);
  }

  public async sendTerminalLine(text: string): Promise<void> {
    await this.primary.sendTerminalLine(text);
  }

  public async terminalText(): Promise<string> {
    return this.primary.terminalText();
  }

  public async closeViewer(): Promise<void> {
    await this.primary.closeViewer();
  }

  public async reopenViewer(baseUrl: string, deadline: number): Promise<void> {
    await this.primary.reopenViewer(baseUrl, deadline);
  }

  public consoleMessages(): string[] {
    return this.primary.consoleMessages();
  }

  public failedRequests(): string[] {
    return this.primary.failedRequests();
  }

  private ensureSurfaceRegistry(): BrowserSurfaceRegistry {
    if (this.runtime.browserSurfaceRegistry) {
      return this.runtime.browserSurfaceRegistry;
    }
    if (!this.runtime.browser || !this.runtime.artifacts) {
      throw new HarnessError(
        "prerequisite",
        "Browser runtime does not support creating additional surfaces",
      );
    }

    this.runtime.browserSurfaceRegistry = new BrowserSurfaceRegistry({
      browser: this.runtime.browser,
      artifactsDir: this.runtime.artifacts.dir,
    });
    return this.runtime.browserSurfaceRegistry;
  }
}
